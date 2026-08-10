# LaniHost SMS notifications

The corresponding source for the deployed AGPL-3.0 build is published at
<https://github.com/mlaniak/documenso-lanihost-source>. Credentials, phone
numbers, and production data are not part of the source repository.

This fork adds SMS as a second delivery channel for signing notifications,
alongside email. Email behaviour is unchanged and SMS never replaces it.

Four events can produce a text: the initial send, a scheduled reminder, a
manual resend, and completion. Each becomes a `ScheduledReminderDelivery` row
with `channel: SMS`, so texts inherit the same retry backoff, stale-claim
recovery, audit entries, and provider status tracking as email reminders. Every
trigger is wrapped so a queueing failure is logged and the email still goes out.

A recipient receives at most four texts per day. Anything beyond that is
recorded as throttled rather than sent.

## Configuration

Credentials are **per team**, because each business verifies its own Twilio
account and a phone number belongs to exactly one account. Storing one global
account SID would mean sending a GulfVestor number's message with EverTrade's
credentials, which Twilio rejects outright.

Per team, in `TeamGlobalSettings.smsSettings`: `enabled`, `senderNumber` in
E.164, `defaultOn`, `brandLabel`, `accountSid`, and `authToken`. Organisation
settings supply the fallback and `DocumentMeta.smsEnabled` overrides per
envelope. Anything unparseable resolves to disabled, so a corrupt row cannot
cause an unintended send.

`authToken` is **encrypted at rest** with `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY`,
the same mechanism the email transport config uses for SMTP passwords, and is
never returned to a client. The UI reports whether a token is configured, never
its value. Losing or rotating that key without re-encrypting makes stored
tokens unrecoverable and they must be re-entered.

Environment variables `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` remain as a
**fallback** for a single-account deployment. A team that sets its own
credentials ignores them. A team with a SID but no token, or vice versa, is
treated as unconfigured rather than silently borrowing the environment's
credentials.

`TWILIO_STATUS_CALLBACK_URL` is no longer used; the callback URL is derived per
team from `NEXT_PUBLIC_WEBAPP_URL`.

## Webhooks

URLs carry the team id, because signature verification needs the sending
account's auth token and there is no single global token to verify against.
Configure both **in each Twilio account**, on that account's number:

- Incoming messages: `POST https://documenso.lanihost.com/api/twilio/inbound-webhook/<teamId>`
- Status callbacks: set automatically per message; nothing to configure

Both verify the `X-Twilio-Signature` header before acting, rejecting anything
unsigned or mis-signed with 403. Signatures are checked against the public URL
built from `NEXT_PUBLIC_WEBAPP_URL` plus the team id, not the request URL,
because the reverse proxy rewrites the host. A signature mismatch on every
request usually means `NEXT_PUBLIC_WEBAPP_URL` does not match the URL
configured in Twilio, or the number is pointed at the wrong team's URL.

## Opt-out

STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, and QUIT write an `SmsOptOut` row
scoped to the team that owns the receiving number. START, YES, and UNSTOP
remove it. HELP and INFO return an identifying message. Only a whole-message
keyword counts, matching Twilio's carrier-level rule, so local suppression
stays in step with what Twilio actually enforces.

STOP replies with empty TwiML on purpose. Twilio's own opt-out confirmation has
already been sent, and a second message would text someone who just asked us to
stop.

Suppression is also written when Twilio rejects a send with error 21610, so a
provider-side unsubscribe stops further attempts locally.

Every send checks suppression first. An unusable or malformed number counts as
suppressed rather than being handed to the provider.

## Delivery status

Status callbacks reuse the reminder delivery ledger. Twilio statuses map onto
`ScheduledReminderProviderStatus`: queued, accepted, scheduled, sending, and
sent become SUBMITTED; delivered becomes DELIVERED; undelivered becomes
BOUNCED; failed becomes FAILED. Anything else, including WhatsApp-only `read`,
is acknowledged and ignored so Twilio does not retry it.

Idempotency uses a `ScheduledReminderProviderEvent` row keyed
`<MessageSid>:<status>`, so Twilio retries cannot double-write.

## Monitoring

`ops/documenso-monitor.py` covers SMS in two ways. The overdue, stale-claim,
and recent-failure checks are channel-agnostic and already include SMS rows.
On top of those it reports SMS-specific failures, carrier rejections
(`providerStatus` BOUNCED or FAILED within the hour), and three or more
opt-outs in 24 hours.

The opt-out check is the early warning that matters most: a burst of STOP
replies means the messaging is unwelcome, and that threatens the A2P
registration well before it shows up as a delivery failure.

Note that the provider-confirmation check accepts a completion delivery on a
completed envelope. Filtering on a pending envelope alone, as it did
originally, would never surface an unconfirmed completion text.

## Compliance

The EverTrade sending number's A2P 10DLC registration is confirmed registered
and approved as of 2026-08-09. A newly provisioned number needs its own
campaign registration before it can carry business traffic reliably.

A signing link is bearer access to a document, so a text to a mistyped number
is a disclosure. Numbers are validated to E.164 and shown in the send dialog
before the send is committed.

## Verifying a configuration

The organisation settings page has a **Send test** control: enter a mobile
number and it sends one real message using the saved settings.

Use it before trusting a configuration. A wrong credential or a number
belonging to a different Twilio account otherwise appears as a text that
silently never arrives, which is the hardest failure here to diagnose. The
control reports Twilio's own error code and message, so a rejection names its
cause.

It refuses before spending anything when SMS is disabled, no credentials
resolve, the number is malformed, or the number has opted out of any team in
the organisation.

## Choosing per document

The send and resend dialogs carry an **Also send a text message** checkbox,
pre-ticked from the team default.

The two dialogs behave differently, deliberately:

- **First send.** Leaving the box untouched stores nothing, so the envelope
  keeps following the team default even if that default changes later. Ticking
  or unticking pins the choice to that envelope in `DocumentMeta.smsEnabled`.
- **Resend.** Leaving the box untouched sends no override, so whatever the
  envelope already had is preserved. It does **not** revert the envelope to
  following the team default; an envelope pinned to true or false stays pinned
  until someone changes it on a resend.

## Setting up a business

Per business, once:

1. Generate the settings row. The auth token must be encrypted with the
   application's own key, so it cannot be written by hand:

   ```bash
   echo "<auth-token>" | npx tsx scripts/configure-team-sms.ts --team-url=<team> --account-sid=<sid> --sender-number=+1XXXXXXXXXX --brand-label="<Brand>"
   ```

   Run it where `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY` is set. It validates the
   input, prints SQL, and never writes the plaintext token anywhere. Review the
   SQL, then run it against the Documenso database.
2. In **that business's own Twilio console**, point its number's incoming
   message webhook at `https://documenso.lanihost.com/api/twilio/inbound-webhook/<teamId>`.
   Status callbacks need no configuration; they are set per message.
3. Send a test envelope to a controlled phone. Confirm the text arrives, the
   link opens the right signing page, and the ledger row reaches SENT then
   DELIVERED.
4. Reply STOP, confirm an `SmsOptOut` row appears scoped to that team, and
   confirm the next send is skipped.
5. Complete the envelope and confirm the completion text.

Each business is independent: an opt-out for one brand does not suppress
another, and one account's credentials are never used with another's number.

## Development notes

A fresh clone cannot run the test suite until the Prisma client is generated:

```bash
npx prisma generate --schema packages/prisma/schema.prisma
```

Prisma CLI commands require `NEXT_PRIVATE_DATABASE_URL` and
`NEXT_PRIVATE_DIRECT_DATABASE_URL` to be set even when they never connect.
Placeholder values are sufficient for `validate`, `generate`, and
`migrate diff`.

CI does **not** build the container image. Typecheck and tests pass happily on
changes that cannot produce a container, and two deploys have been broken that
way. The `image` job exists and now points at the right Dockerfile, but it only
runs on manual dispatch: on a standard hosted runner the remix build aborts
with exit 134 (heap exhaustion), where the 31 GB VPS succeeds. Until that is
resolved, a container build is only proven on the server.

`apps/remix` builds through `bash ./.bin/build.sh`. The `bash` prefix is
required: invoked directly, npm runs it under `cmd.exe` on Windows, which
cannot execute a shell script, and the build fails before it typechecks
anything. Always read `BUILD_EXIT` from the build log rather than the exit code
of a pipeline that ends in `grep` or `tail`.
