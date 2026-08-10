# SMS notifications design

Status: approved design, not yet implemented.
Date: 2026-08-09.
Base: Documenso 2.15.0, LaniHost customization fork.

## Problem

Signing request emails sometimes land in recipient spam folders. Signers do not
see the document, and the sender has no signal that delivery failed, because an
accepted SMTP handoff is not the same as a read message. Text messages are a
practical second channel for the same notification.

## Goal

Add SMS as a second delivery channel for signing notifications, controlled per
team, starting with EverTrade. Email behavior does not change. SMS accompanies
email and never replaces it. A failed or skipped text never blocks an email.

## Non-goals for the first release

- Automatic phone lookup from an external CRM.
- Per-recipient SMS checkboxes in the send dialog.
- A dedicated document delivery phone number.
- Two-way messaging beyond STOP and HELP.
- WhatsApp, RCS, or link shortening.
- Configuring a second brand. Settings are per team from day one, but only the
  EverTrade team is configured.

## Approach

SMS becomes a channel on the existing `ScheduledReminderDelivery` ledger rather
than a parallel delivery system. The ledger already provides durable
per-recipient records, atomic worker claims, bounded retry backoff, stale claim
recovery, terminal outcome storage, provider delivery status, and audit log
integration. Reusing it means text messages inherit all of that, and there is
one source of truth for whether a recipient was reached.

Initial send, manual resend, and completion texts are ledger rows due
immediately. Scheduled reminder texts are ledger rows due later. One worker
handles all of them.

## Data model

All changes live in `packages/prisma/schema.prisma` with a migration.

### Recipient

Add `phone String?` stored in E.164. Nullable, because most recipients will not
have one and every code path must tolerate its absence.

### ScheduledReminderDelivery

Add two enum columns:

- `channel`: `EMAIL` or `SMS`, defaulting to `EMAIL` so existing rows keep their
  meaning.
- `kind`: `SIGNING_REQUEST`, `REMINDER`, or `COMPLETION`, defaulting to
  `REMINDER` for the same reason.

The existing rule that only one record may be active per recipient applies to
`REMINDER` rows and becomes one active reminder per recipient per channel. Email
reminders and SMS reminders for the same recipient are independent rows that
succeed or fail independently.

`SIGNING_REQUEST` and `COMPLETION` rows are one-shot and exempt from that rule,
because a signing request row and a scheduled reminder row legitimately coexist
for the same recipient from the moment an envelope is sent. Completion still
cancels any pending reminder rows first, so a completion row is never racing a
reminder for the same recipient.

The existing provider fields carry Twilio state without new columns.
`providerMessageId` holds the Twilio message SID. `providerStatus` and the
provider timestamp fields are driven by the Twilio status callback the same way
the Resend webhook drives them for email.

### Team and organisation settings

Add `smsSettings Json?` to both `TeamGlobalSettings` and
`OrganisationGlobalSettings`, with a Zod schema, matching the existing
`reminderSettings` pattern and inheriting through the same resolution chain.

The schema holds:

- `enabled`: whether the team may send SMS at all.
- `senderNumber`: the E.164 from number for this team.
- `defaultOn`: whether the send dialog toggle starts checked.
- `brandLabel`: the short name used in the message body.

### SmsOptOut

A new table recording suppressed numbers.

- `phone`: E.164.
- `teamId`: scope, because opting out of one brand does not opt out of another.
- `reason`: `STOP`, `MANUAL`, or `PROVIDER_PERMANENT`.
- `createdAt`.

Unique on `(phone, teamId)`. Consulted before every send with no exceptions.

## Transport

A Twilio client under `packages/lib/server-only/sms/`, behind a narrow provider
interface with exactly one implementation. The interface exists so the provider
can be swapped, not because a second provider is planned.

Credentials come from environment variables only. The corresponding source is
published publicly under AGPL-3.0, so no account SID, auth token, or phone
number may appear in the repository. New variables:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_STATUS_CALLBACK_URL`

The from number is per team in `smsSettings`, not an environment variable,
because it differs per brand.

## Sender number

EverTrade sends from its existing Twilio number rather than a newly provisioned
one. That number's A2P 10DLC registration is confirmed registered and approved
as of 2026-08-09, and its replies already reach a monitored inbox, so there is
no registration lead time before the first send. A dedicated number can replace
it later by editing team settings, but it would need its own campaign
registration first.

## Message content

Messages are short, targeting a single segment. Each contains the brand label, a
single line of context, and the recipient signing link, which is the same
`/sign/{token}` URL the email uses. The first message sent to a given number
includes opt-out instructions.

Completion messages confirm the document is fully executed and say where the
signed copy is. They do not need to carry a link.

## Triggers

Four events can produce a text, each independently governed by the resolved
toggle:

1. Initial send of the envelope.
2. A scheduled reminder.
3. A manual resend.
4. Completion, once every recipient has signed.

## Control model

The toggle resolves in two levels. The team setting supplies the default, and
the send dialog toggle overrides it for a single envelope. There is no
per-recipient checkbox. A recipient with no phone number, or a suppressed
number, is skipped silently and shown as skipped, which is not an error state.

## User interface

- Send dialog: a mobile number field beside each recipient's email, and an
  "Also send a text" toggle pre-set from the resolved team default.
- Team settings: an SMS section exposing enabled, sender number, default state,
  and brand label.
- Document view: SMS delivery state shown next to the existing reminder status,
  reusing the components already built. States are sent, delivered, failed,
  opted out, and no number.
- Resend action: a channel choice, so a resend can be email, text, or both.

## Compliance and safety

These requirements are not optional and are part of the definition of done.

- An inbound Twilio webhook handles `STOP` and its variants by writing an
  `SmsOptOut` row. A suppressed number is never texted again for that team.
- Both inbound webhooks, the message handler and the status callback, verify the
  Twilio request signature before acting. An unsigned or mis-signed request is
  rejected, because an unauthenticated status callback could otherwise forge
  delivery confirmations and an unauthenticated message handler could forge or
  suppress opt-outs.
- `HELP` receives a reply identifying the sender and how to reach a human.
- The first message to a number carries opt-out instructions.
- Numbers are validated and normalized to E.164 before storage and before send.

A signing link is bearer access to the document. A text to a mistyped number is
a disclosure, which makes this stricter than ordinary notification work. The
mitigations are E.164 validation, showing the number in the send dialog before
the send is committed, and the fact that Documenso recipient authentication
options still apply to the link itself.

## Failure handling

Twilio errors are classified as retryable or terminal.

- Retryable: transient network failures, rate limiting, and provider 5xx. These
  follow the existing backoff of 5 minutes, 15 minutes, 45 minutes, 135 minutes,
  and 6 hours.
- Terminal: invalid number, unreachable landline, and unsubscribed recipient.
  These set `FAILED` immediately with `retryable` false, so no attempts are
  wasted, and the reason is written to the audit log and shown in the UI.

A permanent unsubscribed response also writes an `SmsOptOut` row with reason
`PROVIDER_PERMANENT`.

Email delivery is independent. An SMS failure never prevents, delays, or
rolls back the corresponding email.

`ops/documenso-monitor.py` extends its overdue and failed delivery queries to
cover the SMS channel, so a stalled SMS worker alerts the same way a stalled
email worker does.

## Testing

Unit coverage:

- Phone normalization and E.164 validation, including rejection cases.
- Opt-out suppression, including team scoping.
- Message building, including segment count and the first-message opt-out
  notice.
- Provider error classification into retryable and terminal.

Integration coverage:

- Ledger state transitions for the SMS channel: claim, retry, terminal failure,
  cancellation on document cancellation, and cancellation on completion.
- Toggle resolution from organisation default through team default to envelope
  override.
- Independence of the email and SMS rows for one recipient.

Twilio is mocked. No test sends a live message.

Before any customer envelope uses the feature, all four triggers are exercised
live against a phone the operator controls.

## Rebase discipline

The fork rebases onto reviewed upstream tags, so every file touched here is a
file that can conflict later. New code lives in new files under `sms/`
directories. Upstream files are modified in as few places as possible:

- `packages/prisma/schema.prisma` and a migration.
- The send dialog component.
- Team settings UI and its router.
- The resend action.
- The scheduled reminder delivery worker.

Document the change in `PUBLIC-SOURCE-NOTICE.md` and add
`docs/lanihost-sms-notifications.md` alongside the existing
`docs/lanihost-scheduled-reminders.md` when the work lands.

## Licensing

The running modified source must remain available under AGPL-3.0 to network
users. The SMS code is published in the source mirror. Credentials are not.
