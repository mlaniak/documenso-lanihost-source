# SMS Compliance Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Twilio's two inbound webhooks — recipient messages and message status callbacks — so opt-out is honoured and delivery state is recorded, before any code can text a customer.

**Architecture:** Mirrors the fork's existing Resend delivery webhook exactly: a thin route under `apps/remix/app/routes/api+/` delegating to a handler in `packages/lib/server-only/`, with signature verification, a payload size cap, Zod parsing, and idempotent persistence. Status events reuse the existing `ScheduledReminderProviderEvent` table and `provider*` ledger columns, so no schema change is required.

**Tech Stack:** TypeScript, React Router v7 resource routes, Prisma, `node:crypto`, Vitest.

## Global Constraints

- Prerequisite: the delivery core plan (`2026-08-09-sms-delivery-core.md`) is merged. This plan consumes `normalisePhoneNumber`, `suppressPhone`, `resolveSmsSettings`, and the `SmsOptOut` model from it.
- Branch: `agent/sms-notifications`.
- **No new npm dependencies.** Twilio signature verification is HMAC-SHA1 via `node:crypto`.
- **No credentials in the repository.** `TWILIO_AUTH_TOKEN` is already declared in `.env.example` and `turbo.json` by the previous plan.
- Read env through `env()` / `requireEnv()` from `packages/lib/utils/env.ts`. Do not read `process.env` directly outside tests.
- Tests: Vitest, colocated. Run with `npm run test -w @documenso/lib`.
- Lint with `npx biome check --write <files>` before committing. Biome collapses multi-line imports, so append-then-patch-imports edits need the collapsed form as the anchor.
- Commits are Conventional Commits. Commit after every task.
- A fresh clone needs `npx prisma generate --schema packages/prisma/schema.prisma` before tests will run.

---

### Task 1: Twilio request signature verification

**Files:**
- Create: `packages/lib/server-only/sms/verify-twilio-signature.ts`
- Test: `packages/lib/server-only/sms/verify-twilio-signature.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildTwilioSignature(options: { url: string; params: Record<string, string>; authToken: string }): string` and `verifyTwilioSignature(options: { url: string; params: Record<string, string>; authToken: string; signature: string | null }): boolean`. Both webhook handlers call `verifyTwilioSignature` before doing anything else.

Twilio signs the full request URL with every POST parameter appended in key order, as `key + value` with no separators, HMAC-SHA1, base64. **The URL must be the public URL Twilio actually called.** This deployment sits behind nginx-proxy-manager, so `request.url` can carry an internal host and would produce a signature mismatch on every request. Handlers therefore build the URL from `NEXT_PUBLIC_WEBAPP_URL` plus the route path, never from `request.url`.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/verify-twilio-signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildTwilioSignature, verifyTwilioSignature } from './verify-twilio-signature';

const authToken = 'test_auth_token';
const url = 'https://documenso.lanihost.com/api/twilio/inbound-webhook';

describe('buildTwilioSignature', () => {
  it('matches the documented twilio algorithm', () => {
    const params = { To: '+18327775620', From: '+18325551234', Body: 'STOP' };

    // Reference implementation: url + each key/value in sorted key order.
    const expected = createHmac('sha1', authToken)
      .update(`${url}Body${params.Body}From${params.From}To${params.To}`)
      .digest('base64');

    expect(buildTwilioSignature({ url, params, authToken })).toBe(expected);
  });

  it('is order independent because parameters are sorted', () => {
    const a = buildTwilioSignature({ url, params: { b: '2', a: '1' }, authToken });
    const b = buildTwilioSignature({ url, params: { a: '1', b: '2' }, authToken });

    expect(a).toBe(b);
  });
});

describe('verifyTwilioSignature', () => {
  const params = { To: '+18327775620', From: '+18325551234', Body: 'STOP' };
  const signature = buildTwilioSignature({ url, params, authToken });

  it('accepts a correct signature', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature })).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyTwilioSignature({
        url,
        params: { ...params, Body: 'START' },
        authToken,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a signature built for a different url', () => {
    expect(
      verifyTwilioSignature({
        url: 'https://evil.example.com/api/twilio/inbound-webhook',
        params,
        authToken,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature: null })).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature: 'not base64!!' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- verify-twilio-signature`
Expected: FAIL, `Cannot find module './verify-twilio-signature'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/verify-twilio-signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio signs the full public request URL followed by every POST parameter in
 * sorted key order, concatenated as key + value with no separator, using
 * HMAC-SHA1 keyed with the account auth token.
 */
export const buildTwilioSignature = (options: {
  url: string;
  params: Record<string, string>;
  authToken: string;
}): string => {
  const payload = Object.keys(options.params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${options.params[key]}`, options.url);

  return createHmac('sha1', options.authToken).update(payload).digest('base64');
};

export const verifyTwilioSignature = (options: {
  url: string;
  params: Record<string, string>;
  authToken: string;
  signature: string | null;
}): boolean => {
  if (!options.signature) {
    return false;
  }

  const expected = buildTwilioSignature(options);
  const expectedBuffer = Buffer.from(expected, 'base64');
  const providedBuffer = Buffer.from(options.signature, 'base64');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- verify-twilio-signature`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/verify-twilio-signature.ts packages/lib/server-only/sms/verify-twilio-signature.test.ts
git commit -m "feat(sms): verify twilio request signatures"
```

---

### Task 2: Inbound keyword classification

**Files:**
- Modify: `packages/lib/constants/sms-delivery.ts`
- Test: `packages/lib/constants/sms-delivery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifySmsKeyword(body: string): 'STOP' | 'START' | 'HELP' | 'OTHER'`. The inbound handler switches on this.

Keyword sets follow Twilio's standard opt-out vocabulary. Matching is case-insensitive and whitespace-trimmed, and only applies when the keyword is the entire message. "Please stop sending me documents" is not an opt-out under Twilio's rules and must classify as `OTHER`, because treating it as STOP would silently suppress a number the carrier still considers subscribed, putting our local state out of sync with Twilio's.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/constants/sms-delivery.test.ts`, and add `classifySmsKeyword` to the existing import from `./sms-delivery`:

```ts
describe('classifySmsKeyword', () => {
  it.each([['STOP'], ['stop'], ['  Stop  '], ['STOPALL'], ['UNSUBSCRIBE'], ['CANCEL'], ['END'], ['QUIT']])(
    'classifies %s as STOP',
    (body) => {
      expect(classifySmsKeyword(body)).toBe('STOP');
    },
  );

  it.each([['START'], ['start'], ['YES'], ['UNSTOP']])('classifies %s as START', (body) => {
    expect(classifySmsKeyword(body)).toBe('START');
  });

  it.each([['HELP'], ['help'], ['INFO']])('classifies %s as HELP', (body) => {
    expect(classifySmsKeyword(body)).toBe('HELP');
  });

  it.each([[''], ['thanks'], ['please stop sending me documents'], ['stop it']])(
    'classifies %s as OTHER',
    (body) => {
      expect(classifySmsKeyword(body)).toBe('OTHER');
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: FAIL, `classifySmsKeyword is not defined`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/lib/constants/sms-delivery.ts`:

```ts
export type SmsKeyword = 'STOP' | 'START' | 'HELP' | 'OTHER';

const SMS_STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const SMS_START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);
const SMS_HELP_KEYWORDS = new Set(['HELP', 'INFO']);

/**
 * Only a whole-message keyword counts. Twilio's carrier-level opt-out uses the
 * same rule, so loosening this would desynchronise our suppression list from
 * the state Twilio actually enforces.
 */
export const classifySmsKeyword = (body: string): SmsKeyword => {
  const keyword = body.trim().toUpperCase();

  if (SMS_STOP_KEYWORDS.has(keyword)) {
    return 'STOP';
  }

  if (SMS_START_KEYWORDS.has(keyword)) {
    return 'START';
  }

  if (SMS_HELP_KEYWORDS.has(keyword)) {
    return 'HELP';
  }

  return 'OTHER';
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/sms-delivery.ts packages/lib/constants/sms-delivery.test.ts
git commit -m "feat(sms): classify inbound opt-out keywords"
```

---

### Task 3: Twilio status mapping

**Files:**
- Modify: `packages/lib/constants/sms-delivery.ts`
- Test: `packages/lib/constants/sms-delivery.test.ts`

**Interfaces:**
- Consumes: `ScheduledReminderProviderStatus` from `@prisma/client`.
- Produces: `mapTwilioMessageStatus(status: string): ScheduledReminderProviderStatus | null`. The status handler uses `null` to mean "a status we deliberately ignore".

Mapping onto the existing enum, which was built for email: `queued`, `accepted`, `scheduled`, `sending`, and `sent` are all "handed off, not confirmed" and become `SUBMITTED`. `delivered` becomes `DELIVERED`. `undelivered` becomes `BOUNCED`, since a carrier refusing the handset is the SMS analogue of a bounce. `failed` becomes `FAILED`. Anything else, including WhatsApp-only `read`, returns `null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/constants/sms-delivery.test.ts`, adding `mapTwilioMessageStatus` to the existing import:

```ts
describe('mapTwilioMessageStatus', () => {
  it.each([
    ['queued', 'SUBMITTED'],
    ['accepted', 'SUBMITTED'],
    ['scheduled', 'SUBMITTED'],
    ['sending', 'SUBMITTED'],
    ['sent', 'SUBMITTED'],
    ['delivered', 'DELIVERED'],
    ['undelivered', 'BOUNCED'],
    ['failed', 'FAILED'],
  ])('maps %s to %s', (status, expected) => {
    expect(mapTwilioMessageStatus(status)).toBe(expected);
  });

  it('is case insensitive', () => {
    expect(mapTwilioMessageStatus('DELIVERED')).toBe('DELIVERED');
  });

  it.each([['read'], ['partially_delivered'], ['']])('ignores %s', (status) => {
    expect(mapTwilioMessageStatus(status)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: FAIL, `mapTwilioMessageStatus is not defined`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/lib/constants/sms-delivery.ts`:

```ts
import type { ScheduledReminderProviderStatus } from '@prisma/client';

const TWILIO_STATUS_MAP: Record<string, ScheduledReminderProviderStatus> = {
  queued: 'SUBMITTED',
  accepted: 'SUBMITTED',
  scheduled: 'SUBMITTED',
  sending: 'SUBMITTED',
  sent: 'SUBMITTED',
  delivered: 'DELIVERED',
  undelivered: 'BOUNCED',
  failed: 'FAILED',
};

/**
 * Null means a status we deliberately ignore rather than an unknown error, so
 * callers acknowledge the webhook instead of making Twilio retry it.
 */
export const mapTwilioMessageStatus = (status: string): ScheduledReminderProviderStatus | null =>
  TWILIO_STATUS_MAP[status.trim().toLowerCase()] ?? null;
```

Move this `import type` to the top of the file with the other imports when Biome reorders it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/sms-delivery.ts packages/lib/constants/sms-delivery.test.ts
git commit -m "feat(sms): map twilio message statuses onto provider statuses"
```

---

### Task 4: Resolve a team from its sender number

**Files:**
- Create: `packages/lib/server-only/sms/resolve-team-by-sender-number.ts`
- Test: `packages/lib/server-only/sms/resolve-team-by-sender-number.test.ts`

**Interfaces:**
- Consumes: `normalisePhoneNumber` from `packages/lib/constants/sms-delivery.ts`.
- Produces: `resolveTeamBySenderNumber(senderNumber: string): Promise<number | null>`. The inbound handler uses it to scope a suppression to the right brand.

Inbound messages arrive with `To` set to our sending number. Suppression is per team, so the number identifies which team the opt-out applies to. The lookup is a JSON path query against `TeamGlobalSettings.smsSettings`.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/resolve-team-by-sender-number.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    team: {
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

const { resolveTeamBySenderNumber } = await import('./resolve-team-by-sender-number');

describe('resolveTeamBySenderNumber', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('returns the team id for a configured sender number', async () => {
    findFirst.mockResolvedValue({ id: 7 });

    await expect(resolveTeamBySenderNumber('+18327775620')).resolves.toBe(7);
  });

  it('normalises the number before querying', async () => {
    findFirst.mockResolvedValue({ id: 7 });

    await resolveTeamBySenderNumber('(832) 777-5620');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        teamGlobalSettings: {
          smsSettings: { path: ['senderNumber'], equals: '+18327775620' },
        },
      },
      select: { id: true },
    });
  });

  it('returns null when no team owns the number', async () => {
    findFirst.mockResolvedValue(null);

    await expect(resolveTeamBySenderNumber('+18327775620')).resolves.toBeNull();
  });

  it('returns null for an unusable number without querying', async () => {
    await expect(resolveTeamBySenderNumber('garbage')).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- resolve-team-by-sender-number`
Expected: FAIL, `Cannot find module './resolve-team-by-sender-number'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/resolve-team-by-sender-number.ts`:

```ts
import { prisma } from '@documenso/prisma';

import { normalisePhoneNumber } from '../../constants/sms-delivery';

/**
 * Inbound messages identify the brand by the number they were sent to, which is
 * how a suppression gets scoped to one team rather than every team.
 */
export const resolveTeamBySenderNumber = async (senderNumber: string): Promise<number | null> => {
  const normalised = normalisePhoneNumber(senderNumber);

  if (!normalised) {
    return null;
  }

  const team = await prisma.team.findFirst({
    where: {
      teamGlobalSettings: {
        smsSettings: { path: ['senderNumber'], equals: normalised },
      },
    },
    select: { id: true },
  });

  return team?.id ?? null;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- resolve-team-by-sender-number`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/resolve-team-by-sender-number.ts packages/lib/server-only/sms/resolve-team-by-sender-number.test.ts
git commit -m "feat(sms): resolve a team from its configured sender number"
```

---

### Task 5: Inbound message webhook handler

**Files:**
- Create: `packages/lib/server-only/sms/handle-twilio-inbound-webhook.ts`
- Test: `packages/lib/server-only/sms/handle-twilio-inbound-webhook.test.ts`

**Interfaces:**
- Consumes: `verifyTwilioSignature` (Task 1), `classifySmsKeyword` (Task 2), `resolveTeamBySenderNumber` (Task 4), `suppressPhone` from the delivery core.
- Produces: `handleTwilioInboundWebhook(request: Request): Promise<Response>` and the exported constant `TWILIO_INBOUND_WEBHOOK_PATH = '/api/twilio/inbound-webhook'`. Task 7's route file calls the handler; the constant is what the signature check uses to rebuild the public URL.

Response conventions follow the Resend handler: 503 when unconfigured, 413 over the size cap, 403 on a bad signature, and 200 with TwiML otherwise.

STOP replies with an empty TwiML document. Twilio's Advanced Opt-Out already sends its own confirmation, and adding ours would text a person who just asked us to stop. HELP replies with one message identifying the sender and giving a human contact.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/handle-twilio-inbound-webhook.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const suppressPhone = vi.fn();
const resolveTeamBySenderNumber = vi.fn();
const verifyTwilioSignature = vi.fn();
const deleteMany = vi.fn();

vi.mock('./sms-opt-out', () => ({
  suppressPhone: (...args: unknown[]) => suppressPhone(...args),
  isPhoneSuppressed: vi.fn(),
}));

vi.mock('./resolve-team-by-sender-number', () => ({
  resolveTeamBySenderNumber: (...args: unknown[]) => resolveTeamBySenderNumber(...args),
}));

vi.mock('./verify-twilio-signature', () => ({
  verifyTwilioSignature: (...args: unknown[]) => verifyTwilioSignature(...args),
  buildTwilioSignature: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: { smsOptOut: { deleteMany: (...args: unknown[]) => deleteMany(...args) } },
}));

const { handleTwilioInboundWebhook } = await import('./handle-twilio-inbound-webhook');

const buildRequest = (body: Record<string, string>) =>
  new Request('http://internal.local/api/twilio/inbound-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'signature',
    },
    body: new URLSearchParams(body).toString(),
  });

describe('handleTwilioInboundWebhook', () => {
  beforeEach(() => {
    suppressPhone.mockReset();
    deleteMany.mockReset();
    resolveTeamBySenderNumber.mockReset().mockResolvedValue(7);
    verifyTwilioSignature.mockReset().mockReturnValue(true);
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
  });

  it('returns 503 when the auth token is not configured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;

    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
    );

    expect(response.status).toBe(503);
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('returns 403 and does nothing when the signature is invalid', async () => {
    verifyTwilioSignature.mockReturnValue(false);

    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
    );

    expect(response.status).toBe(403);
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('verifies against the public url, not the request url', async () => {
    await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
    );

    expect(verifyTwilioSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://documenso.lanihost.com/api/twilio/inbound-webhook',
      }),
    );
  });

  it('suppresses the sender on STOP and replies with empty twiml', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
    );

    expect(suppressPhone).toHaveBeenCalledWith({
      phone: '+18325551234',
      teamId: 7,
      reason: 'STOP',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');
    await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('removes the suppression on START', async () => {
    await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'START' }),
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { phone: '+18325551234', teamId: 7 },
    });
  });

  it('replies with a help message on HELP', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'HELP' }),
    );

    await expect(response.text()).resolves.toContain('<Message>');
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('ignores an ordinary reply without suppressing anything', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'thanks!' }),
    );

    expect(response.status).toBe(200);
    expect(suppressPhone).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('still acknowledges when no team owns the receiving number', async () => {
    resolveTeamBySenderNumber.mockResolvedValue(null);

    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+15550000000', Body: 'STOP' }),
    );

    expect(response.status).toBe(200);
    expect(suppressPhone).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- handle-twilio-inbound-webhook`
Expected: FAIL, `Cannot find module './handle-twilio-inbound-webhook'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/handle-twilio-inbound-webhook.ts`:

```ts
import { prisma } from '@documenso/prisma';

import { classifySmsKeyword, normalisePhoneNumber } from '../../constants/sms-delivery';
import { env } from '../../utils/env';
import { resolveTeamBySenderNumber } from './resolve-team-by-sender-number';
import { suppressPhone } from './sms-opt-out';
import { verifyTwilioSignature } from './verify-twilio-signature';

export const TWILIO_INBOUND_WEBHOOK_PATH = '/api/twilio/inbound-webhook';

const MAX_TWILIO_WEBHOOK_BYTES = 16 * 1024;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const twimlResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });

const messageTwiml = (message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;

export const handleTwilioInboundWebhook = async (request: Request): Promise<Response> => {
  const authToken = env('TWILIO_AUTH_TOKEN');

  if (!authToken) {
    return new Response('Webhook unavailable', { status: 503 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');

  if (Number.isFinite(contentLength) && contentLength > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const rawBody = await request.text();

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  // Built from configuration, never request.url: the reverse proxy rewrites the
  // host, and Twilio signed the public URL.
  const url = `${env('NEXT_PUBLIC_WEBAPP_URL') ?? ''}${TWILIO_INBOUND_WEBHOOK_PATH}`;

  const isValid = verifyTwilioSignature({
    url,
    params,
    authToken,
    signature: request.headers.get('x-twilio-signature'),
  });

  if (!isValid) {
    return new Response('Invalid signature', { status: 403 });
  }

  const keyword = classifySmsKeyword(params.Body ?? '');

  if (keyword === 'OTHER') {
    return twimlResponse(EMPTY_TWIML);
  }

  const teamId = await resolveTeamBySenderNumber(params.To ?? '');

  if (teamId === null) {
    // Acknowledge so Twilio stops retrying, but change nothing: we cannot tell
    // which brand this opt-out belongs to.
    return twimlResponse(EMPTY_TWIML);
  }

  if (keyword === 'STOP') {
    await suppressPhone({ phone: params.From ?? '', teamId, reason: 'STOP' });

    // Twilio's own opt-out confirmation already went out. A second message
    // would text someone who just asked us to stop.
    return twimlResponse(EMPTY_TWIML);
  }

  if (keyword === 'START') {
    // Normalise on read as well as write. suppressPhone stores E.164, so
    // deleting by a raw provider value would silently fail to lift the
    // suppression if Twilio ever changed its formatting.
    const phone = normalisePhoneNumber(params.From ?? '');

    if (phone) {
      await prisma.smsOptOut.deleteMany({ where: { phone, teamId } });
    }

    return twimlResponse(EMPTY_TWIML);
  }

  return twimlResponse(
    messageTwiml(
      'This number sends document signing links. Reply STOP to opt out. For help, contact the sender named in your document email.',
    ),
  );
};
```

**Interfaces consumed, restated:** `normalisePhoneNumber` and `classifySmsKeyword` both come from `packages/lib/constants/sms-delivery.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- handle-twilio-inbound-webhook`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/handle-twilio-inbound-webhook.ts packages/lib/server-only/sms/handle-twilio-inbound-webhook.test.ts
git commit -m "feat(sms): handle inbound twilio stop, start, and help"
```

---

### Task 6: Status callback webhook handler

**Files:**
- Create: `packages/lib/server-only/sms/handle-twilio-status-webhook.ts`
- Test: `packages/lib/server-only/sms/handle-twilio-status-webhook.test.ts`

**Interfaces:**
- Consumes: `verifyTwilioSignature` (Task 1), `mapTwilioMessageStatus` (Task 3).
- Produces: `handleTwilioStatusWebhook(request: Request): Promise<Response>` and `TWILIO_STATUS_WEBHOOK_PATH = '/api/twilio/status-webhook'`.

Idempotency reuses `ScheduledReminderProviderEvent` with a composite id of `${MessageSid}:${MessageStatus}`, since Twilio sends each status once per message but retries on non-2xx. `providerEmailId` stays null for SMS; `messageId` holds the Twilio SID, which is what `sendSms` wrote to `providerMessageId`.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/handle-twilio-status-webhook.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const createMany = vi.fn();
const updateMany = vi.fn();
const verifyTwilioSignature = vi.fn();

vi.mock('./verify-twilio-signature', () => ({
  verifyTwilioSignature: (...args: unknown[]) => verifyTwilioSignature(...args),
  buildTwilioSignature: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    scheduledReminderDelivery: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    scheduledReminderProviderEvent: {
      createMany: (...args: unknown[]) => createMany(...args),
    },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        scheduledReminderDelivery: { updateMany: (...args: unknown[]) => updateMany(...args) },
        scheduledReminderProviderEvent: { createMany: (...args: unknown[]) => createMany(...args) },
      }),
  },
}));

const { handleTwilioStatusWebhook } = await import('./handle-twilio-status-webhook');

const buildRequest = (body: Record<string, string>) =>
  new Request('http://internal.local/api/twilio/status-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'signature',
    },
    body: new URLSearchParams(body).toString(),
  });

describe('handleTwilioStatusWebhook', () => {
  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ id: 'delivery-1' });
    createMany.mockReset().mockResolvedValue({ count: 1 });
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    verifyTwilioSignature.mockReset().mockReturnValue(true);
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
  });

  it('returns 403 on an invalid signature', async () => {
    verifyTwilioSignature.mockReturnValue(false);

    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
    );

    expect(response.status).toBe(403);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('records a delivered status against the matching delivery', async () => {
    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { providerMessageId: 'SM1' },
      select: { id: true },
    });
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 'SM1:delivered', messageId: 'SM1' })],
        skipDuplicates: true,
      }),
    );
    expect(response.status).toBe(200);
  });

  it('is idempotent when the same status arrives twice', async () => {
    createMany.mockResolvedValue({ count: 0 });

    await handleTwilioStatusWebhook(buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }));

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('acknowledges an unknown message sid without writing', async () => {
    findUnique.mockResolvedValue(null);

    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM_unknown', MessageStatus: 'delivered' }),
    );

    expect(response.status).toBe(200);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('acknowledges an ignored status without writing', async () => {
    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM1', MessageStatus: 'read' }),
    );

    expect(response.status).toBe(200);
    expect(createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- handle-twilio-status-webhook`
Expected: FAIL, `Cannot find module './handle-twilio-status-webhook'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/handle-twilio-status-webhook.ts`:

```ts
import { prisma } from '@documenso/prisma';

import { mapTwilioMessageStatus } from '../../constants/sms-delivery';
import { env } from '../../utils/env';
import { verifyTwilioSignature } from './verify-twilio-signature';

export const TWILIO_STATUS_WEBHOOK_PATH = '/api/twilio/status-webhook';

const MAX_TWILIO_WEBHOOK_BYTES = 16 * 1024;

export const handleTwilioStatusWebhook = async (request: Request): Promise<Response> => {
  const authToken = env('TWILIO_AUTH_TOKEN');

  if (!authToken) {
    return new Response('Webhook unavailable', { status: 503 });
  }

  const rawBody = await request.text();

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const url = `${env('NEXT_PUBLIC_WEBAPP_URL') ?? ''}${TWILIO_STATUS_WEBHOOK_PATH}`;

  const isValid = verifyTwilioSignature({
    url,
    params,
    authToken,
    signature: request.headers.get('x-twilio-signature'),
  });

  if (!isValid) {
    return new Response('Invalid signature', { status: 403 });
  }

  const messageSid = params.MessageSid ?? '';
  const rawStatus = params.MessageStatus ?? '';
  const providerStatus = mapTwilioMessageStatus(rawStatus);

  // Acknowledge statuses we ignore, so Twilio does not retry them.
  if (!messageSid || !providerStatus) {
    return Response.json({ received: true, processed: false });
  }

  const delivery = await prisma.scheduledReminderDelivery.findUnique({
    where: { providerMessageId: messageSid },
    select: { id: true },
  });

  if (!delivery) {
    return Response.json({ received: true, processed: false });
  }

  const occurredAt = new Date();
  const normalisedStatus = rawStatus.trim().toLowerCase();

  const processed = await prisma.$transaction(async (tx) => {
    const inserted = await tx.scheduledReminderProviderEvent.createMany({
      data: [
        {
          id: `${messageSid}:${normalisedStatus}`,
          eventType: normalisedStatus,
          occurredAt,
          messageId: messageSid,
          deliveryId: delivery.id,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      return false;
    }

    await tx.scheduledReminderDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        providerStatus,
        providerStatusAt: occurredAt,
        ...(providerStatus === 'DELIVERED' ? { providerDeliveredAt: occurredAt } : {}),
        ...(providerStatus === 'BOUNCED' || providerStatus === 'FAILED'
          ? { providerFailedAt: occurredAt, providerFailureCode: params.ErrorCode ?? null }
          : {}),
      },
    });

    return true;
  });

  return Response.json({ received: true, processed });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- handle-twilio-status-webhook`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/handle-twilio-status-webhook.ts packages/lib/server-only/sms/handle-twilio-status-webhook.test.ts
git commit -m "feat(sms): record twilio delivery status callbacks"
```

---

### Task 7: Routes, documentation, and verification

**Files:**
- Create: `apps/remix/app/routes/api+/twilio.inbound-webhook.ts`
- Create: `apps/remix/app/routes/api+/twilio.status-webhook.ts`
- Create: `docs/lanihost-sms-notifications.md`
- Modify: `PUBLIC-SOURCE-NOTICE.md`

**Interfaces:**
- Consumes: both handlers from Tasks 5 and 6.
- Produces: two live endpoints at `/api/twilio/inbound-webhook` and `/api/twilio/status-webhook`.

Route filenames use the `api+/` flat-routes convention where a dot becomes a path separator, matching `resend.delivery-webhook.ts` which serves `/api/resend/delivery-webhook`.

- [ ] **Step 1: Create the inbound route**

Create `apps/remix/app/routes/api+/twilio.inbound-webhook.ts`:

```ts
import { handleTwilioInboundWebhook } from '@documenso/lib/server-only/sms/handle-twilio-inbound-webhook';

import type { Route } from './+types/twilio.inbound-webhook';

export const action = async ({ request }: Route.ActionArgs) => await handleTwilioInboundWebhook(request);
```

- [ ] **Step 2: Create the status route**

Create `apps/remix/app/routes/api+/twilio.status-webhook.ts`:

```ts
import { handleTwilioStatusWebhook } from '@documenso/lib/server-only/sms/handle-twilio-status-webhook';

import type { Route } from './+types/twilio.status-webhook';

export const action = async ({ request }: Route.ActionArgs) => await handleTwilioStatusWebhook(request);
```

- [ ] **Step 3: Confirm the routes typecheck and build**

Run: `npm run build --workspace @documenso/remix`
Expected: success. React Router generates `./+types/twilio.inbound-webhook` and `./+types/twilio.status-webhook` during the build; if the type import errors before generation, run the build once and retry.

- [ ] **Step 4: Write the operations document**

Create `docs/lanihost-sms-notifications.md`:

```markdown
# LaniHost SMS notifications

The corresponding source for the deployed AGPL-3.0 build is published at
<https://github.com/mlaniak/documenso-lanihost-source>. Credentials, phone
numbers, and production data are not part of the source repository.

This fork adds SMS as a second delivery channel for signing notifications,
alongside email. Email behaviour is unchanged and SMS never replaces it.

## Configuration

Environment: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
`TWILIO_STATUS_CALLBACK_URL`. Unset credentials disable SMS entirely and both
webhooks answer 503.

Per team, in `TeamGlobalSettings.smsSettings`: `enabled`, `senderNumber` in
E.164, `defaultOn`, and `brandLabel`. Organisation settings supply the fallback
and `DocumentMeta.smsEnabled` overrides per envelope. Anything unparseable
resolves to disabled, so a corrupt row cannot cause an unintended send.

## Webhooks

Configure both in the Twilio console for the sending number:

- Incoming messages: `POST https://documenso.lanihost.com/api/twilio/inbound-webhook`
- Status callbacks: `POST https://documenso.lanihost.com/api/twilio/status-webhook`

Both verify the `X-Twilio-Signature` header before acting, rejecting anything
unsigned with 403. Signatures are checked against the public URL built from
`NEXT_PUBLIC_WEBAPP_URL`, not the request URL, because the reverse proxy
rewrites the host.

## Opt-out

STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, and QUIT write an `SmsOptOut` row
scoped to the team that owns the receiving number. START, YES, and UNSTOP
remove it. HELP and INFO return an identifying message. Only a whole-message
keyword counts, matching Twilio's carrier-level rule.

Suppression is also written when Twilio rejects a send with error 21610, so a
provider-side unsubscribe stops further attempts locally.

Every send checks suppression first. An unusable or malformed number counts as
suppressed rather than being handed to the provider.

## Delivery status

Status callbacks reuse the reminder delivery ledger. Twilio statuses map onto
`ScheduledReminderProviderStatus`: queued, accepted, scheduled, sending, and
sent become SUBMITTED; delivered becomes DELIVERED; undelivered becomes
BOUNCED; failed becomes FAILED. Idempotency uses a
`ScheduledReminderProviderEvent` row keyed `<MessageSid>:<status>`.

## Compliance

The EverTrade sending number's A2P 10DLC registration is confirmed registered
and approved as of 2026-08-09. A newly provisioned number needs its own
campaign registration before it can carry business traffic reliably.

A signing link is bearer access to a document, so a text to a mistyped number
is a disclosure. Numbers are validated to E.164 and shown in the send dialog
before the send is committed.
```

- [ ] **Step 5: Update the public source notice**

In `PUBLIC-SOURCE-NOTICE.md`, replace the sentence beginning "The customization adds one-off scheduled" with:

```markdown
This repository provides the corresponding AGPL-3.0 source code for a modified
self-hosted Documenso deployment. The customization adds one-off scheduled
signing reminders, retry-safe per-recipient delivery records, audit history,
status feedback, operational monitoring examples, and SMS notifications with
per-team sender numbers and opt-out handling.
```

- [ ] **Step 6: Verify the full suite and lint**

Run: `npm run test -w @documenso/lib`
Expected: PASS, including every test from the delivery core plan.

Run: `npx biome check packages/lib/server-only/sms packages/lib/constants/sms-delivery.ts apps/remix/app/routes/api+/twilio.inbound-webhook.ts apps/remix/app/routes/api+/twilio.status-webhook.ts`
Expected: no findings.

- [ ] **Step 7: Commit**

```bash
git add apps/remix/app/routes/api+/twilio.inbound-webhook.ts apps/remix/app/routes/api+/twilio.status-webhook.ts docs/lanihost-sms-notifications.md PUBLIC-SOURCE-NOTICE.md
git commit -m "feat(sms): expose twilio webhook routes and document operations"
```

---

## Verification

After Task 7:

- Both endpoints exist and reject unsigned requests with 403.
- A STOP from a recipient writes a team-scoped `SmsOptOut` row that `sendSms` already honours.
- Delivery statuses land on the existing ledger columns and are idempotent under Twilio retries.
- `npm run test -w @documenso/lib` passes.
- No credential appears in the diff.

Post-deploy, configure both webhook URLs on the sending number in the Twilio console. Until that is done the endpoints exist but Twilio never calls them, and opt-out relies solely on Twilio's carrier-level handling with no local record.

## Not included

- Sending anything. No trigger calls `sendSms` yet; that is the next plan.
- UI. The phone field, the send toggle, and the settings section come after triggers.
- Monitoring. Extending `ops/documenso-monitor.py` to the SMS channel lands with the operations plan.
