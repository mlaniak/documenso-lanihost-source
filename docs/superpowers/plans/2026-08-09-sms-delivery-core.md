# SMS Delivery Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation that can send one compliant SMS to one recipient, with normalized numbers, per-team settings, opt-out suppression, and Twilio error classification, without any user-facing surface yet.

**Architecture:** Pure helpers live in `packages/lib/constants/sms-delivery.ts`, matching the existing `scheduled-reminder-delivery.ts` convention in this fork. Persistence extends the existing `ScheduledReminderDelivery` ledger with a channel rather than adding a parallel system. The Twilio transport is a thin `fetch` wrapper, deliberately not the `twilio` npm package.

**Tech Stack:** TypeScript, Prisma with PostgreSQL, Vitest, Biome, Twilio Messages REST API v2010.

## Global Constraints

- Base spec: `docs/superpowers/specs/2026-08-09-sms-notifications-design.md`. Read it before starting.
- Branch: `agent/sms-notifications`, off `lanihost/main`.
- **No new npm dependencies.** Use `fetch` and `node:crypto`. The fork already carries 35 Dependabot advisories; the Twilio REST call is a form POST and does not justify another supply-chain edge.
- **No credentials in the repository, ever.** The corresponding source is published publicly at `mlaniak/documenso-lanihost-source` under AGPL-3.0. Account SID, auth token, and phone numbers come from environment variables or the database.
- Phone numbers are stored and compared in E.164 only. Never store a formatted or local-format number.
- Tests: Vitest, colocated as `<name>.test.ts` beside the module, matching `packages/lib/constants/scheduled-reminder-delivery.test.ts`.
- Run tests with `npm run test -w @documenso/lib`.
- Lint with `npm run lint` (Biome). Fix with `npm run lint:fix`.
- Commits are Conventional Commits, enforced by commitlint. Commit after every task.
- Minimize the diff against upstream. New behavior goes in new files; existing files gain the smallest possible edit.

---

### Task 1: Phone number normalization

**Files:**
- Create: `packages/lib/constants/sms-delivery.ts`
- Test: `packages/lib/constants/sms-delivery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SMS_E164_PATTERN: RegExp`, `normalisePhoneNumber(value: string, defaultCountryCode?: string): string | null`. Every later task that accepts a phone number calls this first and treats `null` as "unusable, skip".

- [ ] **Step 1: Write the failing test**

Create `packages/lib/constants/sms-delivery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { normalisePhoneNumber } from './sms-delivery';

describe('normalisePhoneNumber', () => {
  it.each([
    ['8325551234', '+18325551234'],
    ['(832) 555-1234', '+18325551234'],
    ['832-555-1234', '+18325551234'],
    ['18325551234', '+18325551234'],
    ['+1 832 555 1234', '+18325551234'],
    ['  +18325551234  ', '+18325551234'],
    ['+442071838750', '+442071838750'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalisePhoneNumber(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['abc'], ['555'], ['+0123456789'], ['+1234567890123456']])(
    'rejects %s',
    (input) => {
      expect(normalisePhoneNumber(input)).toBeNull();
    },
  );

  it('honours a non-US default country code', () => {
    expect(normalisePhoneNumber('2071838750', '44')).toBe('+442071838750');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: FAIL, `Failed to resolve import "./sms-delivery"`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/constants/sms-delivery.ts`:

```ts
export const SMS_E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Converts loosely formatted input into E.164, or null when the value cannot be
 * a valid mobile number. Null means "skip this recipient", never "throw".
 */
export const normalisePhoneNumber = (value: string, defaultCountryCode = '1'): string | null => {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  const hasCountryPrefix = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (digits === '') {
    return null;
  }

  const candidate =
    hasCountryPrefix || digits.length > 10 ? `+${digits}` : `+${defaultCountryCode}${digits}`;

  return SMS_E164_PATTERN.test(candidate) ? candidate : null;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: PASS, 15 assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/sms-delivery.ts packages/lib/constants/sms-delivery.test.ts
git commit -m "feat(sms): add E.164 phone normalisation"
```

---

### Task 2: Twilio error classification

**Files:**
- Modify: `packages/lib/constants/sms-delivery.ts`
- Test: `packages/lib/constants/sms-delivery.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime, same file.
- Produces: `SmsSendError` (class with `code: number`, `status: number`, `message: string`), `isTwilioErrorTerminal(error: unknown): boolean`, `isTwilioOptOutError(error: unknown): boolean`. The delivery worker uses these to decide `FAILED` versus retry, and to write suppression rows.

Retry backoff is **not** reimplemented. The existing `getScheduledReminderRetryAt` in `packages/lib/constants/scheduled-reminder-delivery.ts` already produces the 5m/15m/45m/135m/6h schedule and is channel-agnostic.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/constants/sms-delivery.test.ts`:

```ts
import { isTwilioErrorTerminal, isTwilioOptOutError, SmsSendError } from './sms-delivery';

describe('twilio error classification', () => {
  it.each([
    [21211, 'invalid to number'],
    [21610, 'unsubscribed recipient'],
    [21612, 'unroutable number'],
    [21614, 'not a mobile number'],
    [30003, 'unreachable handset'],
    [30006, 'landline or unreachable carrier'],
  ])('treats twilio code %i as terminal', (code) => {
    expect(isTwilioErrorTerminal(new SmsSendError('failed', { code, status: 400 }))).toBe(true);
  });

  it.each([
    [20429, 429],
    [20500, 500],
    [20503, 503],
  ])('treats twilio code %i as retryable', (code, status) => {
    expect(isTwilioErrorTerminal(new SmsSendError('failed', { code, status }))).toBe(false);
  });

  it('treats a network error as retryable', () => {
    expect(isTwilioErrorTerminal(new Error('socket hang up'))).toBe(false);
  });

  it('identifies only code 21610 as an opt-out', () => {
    expect(isTwilioOptOutError(new SmsSendError('stop', { code: 21610, status: 400 }))).toBe(true);
    expect(isTwilioOptOutError(new SmsSendError('bad', { code: 21211, status: 400 }))).toBe(false);
    expect(isTwilioOptOutError(new Error('socket hang up'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: FAIL, `SmsSendError is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/lib/constants/sms-delivery.ts`:

```ts
/**
 * Twilio error codes that will never succeed on retry. Anything absent from
 * this set is treated as transient, because wasting five attempts is cheaper
 * than silently dropping a deliverable message.
 */
export const TWILIO_TERMINAL_ERROR_CODES = new Set([
  21211, // Invalid 'To' number
  21408, // Permission to send to this region is not enabled
  21610, // Recipient has unsubscribed
  21612, // Number is unroutable
  21614, // 'To' number is not a valid mobile number
  30003, // Unreachable destination handset
  30005, // Unknown destination handset
  30006, // Landline or unreachable carrier
]);

export const TWILIO_OPT_OUT_ERROR_CODE = 21610;

export class SmsSendError extends Error {
  public readonly code: number;
  public readonly status: number;

  constructor(message: string, options: { code: number; status: number }) {
    super(message);
    this.name = 'SmsSendError';
    this.code = options.code;
    this.status = options.status;
  }
}

export const isTwilioErrorTerminal = (error: unknown): boolean =>
  error instanceof SmsSendError && TWILIO_TERMINAL_ERROR_CODES.has(error.code);

export const isTwilioOptOutError = (error: unknown): boolean =>
  error instanceof SmsSendError && error.code === TWILIO_OPT_OUT_ERROR_CODE;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/sms-delivery.ts packages/lib/constants/sms-delivery.test.ts
git commit -m "feat(sms): classify twilio errors as terminal or retryable"
```

---

### Task 3: Message bodies and segment counting

**Files:**
- Modify: `packages/lib/constants/sms-delivery.ts`
- Test: `packages/lib/constants/sms-delivery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getSmsSegmentCount(body: string): number`, `buildSigningRequestSms(options: SigningRequestSmsOptions): string`, `buildCompletionSms(options: CompletionSmsOptions): string`, and the two option types. The delivery worker calls these to produce the exact string handed to Twilio.

`SigningRequestSmsOptions` is `{ brandLabel: string; signingUrl: string; includeOptOutNotice: boolean }`.
`CompletionSmsOptions` is `{ brandLabel: string; documentTitle: string; includeOptOutNotice: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/constants/sms-delivery.test.ts`:

```ts
import { buildCompletionSms, buildSigningRequestSms, getSmsSegmentCount } from './sms-delivery';

describe('sms message bodies', () => {
  it('builds a signing request containing the brand and link', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: false,
    });

    expect(body).toContain('EverTrade');
    expect(body).toContain('https://documenso.lanihost.com/sign/abc123');
    expect(body).not.toContain('STOP');
  });

  it('appends the opt-out notice on a first message', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: true,
    });

    expect(body).toContain('Reply STOP to opt out');
  });

  it('builds a completion message naming the document', () => {
    const body = buildCompletionSms({
      brandLabel: 'EverTrade',
      documentTitle: 'Introductory Employment Agreement',
      includeOptOutNotice: false,
    });

    expect(body).toContain('Introductory Employment Agreement');
    expect(body).toContain('EverTrade');
  });

  it('keeps a typical signing request to one segment', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: false,
    });

    expect(getSmsSegmentCount(body)).toBe(1);
  });

  it.each([
    ['a'.repeat(160), 1],
    ['a'.repeat(161), 2],
    ['a'.repeat(306), 2],
    ['a'.repeat(307), 3],
  ])('counts a %s-character gsm body correctly', (body, expected) => {
    expect(getSmsSegmentCount(body)).toBe(expected);
  });

  it.each([
    ['中'.repeat(70), 1],
    ['中'.repeat(71), 2],
  ])('counts a non-gsm body using the 70-character limit', (body, expected) => {
    expect(getSmsSegmentCount(body)).toBe(expected);
  });

  it('still counts accented latin as gsm, not unicode', () => {
    // é is in the GSM-7 basic charset, so 100 of them is one segment, not two.
    expect(getSmsSegmentCount('é'.repeat(100))).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: FAIL, `getSmsSegmentCount is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/lib/constants/sms-delivery.ts`:

```ts
const GSM7_CHARACTERS =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const GSM7_EXTENDED_CHARACTERS = '^{}\\[~]|€';

const SMS_OPT_OUT_NOTICE = 'Reply STOP to opt out.';

const isGsm7 = (body: string): boolean =>
  [...body].every(
    (character) =>
      GSM7_CHARACTERS.includes(character) || GSM7_EXTENDED_CHARACTERS.includes(character),
  );

/**
 * Segment count drives cost and truncation risk. GSM-7 fits 160 characters in
 * one segment and 153 per segment once concatenated; UCS-2 fits 70 and 67.
 */
export const getSmsSegmentCount = (body: string): number => {
  const length = [...body].length;

  if (length === 0) {
    return 0;
  }

  const single = isGsm7(body) ? 160 : 70;
  const concatenated = isGsm7(body) ? 153 : 67;

  return length <= single ? 1 : Math.ceil(length / concatenated);
};

export type SigningRequestSmsOptions = {
  brandLabel: string;
  signingUrl: string;
  includeOptOutNotice: boolean;
};

export type CompletionSmsOptions = {
  brandLabel: string;
  documentTitle: string;
  includeOptOutNotice: boolean;
};

const withOptOutNotice = (body: string, includeOptOutNotice: boolean): string =>
  includeOptOutNotice ? `${body} ${SMS_OPT_OUT_NOTICE}` : body;

export const buildSigningRequestSms = (options: SigningRequestSmsOptions): string =>
  withOptOutNotice(
    `${options.brandLabel}: you have a document to sign. ${options.signingUrl}`,
    options.includeOptOutNotice,
  );

export const buildCompletionSms = (options: CompletionSmsOptions): string =>
  withOptOutNotice(
    `${options.brandLabel}: "${options.documentTitle}" is fully signed. The completed copy is in your email.`,
    options.includeOptOutNotice,
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/sms-delivery.ts packages/lib/constants/sms-delivery.test.ts
git commit -m "feat(sms): add message builders and segment counting"
```

---

### Task 4: Team SMS settings schema and resolution

**Files:**
- Create: `packages/lib/types/sms-settings.ts`
- Test: `packages/lib/types/sms-settings.test.ts`

**Interfaces:**
- Consumes: `SMS_E164_PATTERN` from `packages/lib/constants/sms-delivery.ts`.
- Produces: `ZSmsSettingsSchema` (Zod), `TSmsSettings` (type), `resolveSmsSettings(options: { organisationSettings: unknown; teamSettings: unknown }): TSmsSettings`. Task 5 stores these as JSON on both settings models; later plans read the resolved value to decide whether to send.

Resolution mirrors the existing nullable-override pattern: a team value wins when present, the organisation value is the fallback, and a hard default applies when both are absent. The hard default is disabled, because a misconfigured team must never text anyone.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/types/sms-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveSmsSettings, ZSmsSettingsSchema } from './sms-settings';

describe('ZSmsSettingsSchema', () => {
  it('accepts a fully specified configuration', () => {
    const parsed = ZSmsSettingsSchema.parse({
      enabled: true,
      senderNumber: '+18327775620',
      defaultOn: true,
      brandLabel: 'EverTrade',
    });

    expect(parsed.senderNumber).toBe('+18327775620');
  });

  it('rejects a sender number that is not E.164', () => {
    expect(() =>
      ZSmsSettingsSchema.parse({
        enabled: true,
        senderNumber: '(832) 777-5620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      }),
    ).toThrow();
  });

  it('rejects an empty brand label', () => {
    expect(() =>
      ZSmsSettingsSchema.parse({
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: '',
      }),
    ).toThrow();
  });
});

describe('resolveSmsSettings', () => {
  const organisationSettings = {
    enabled: true,
    senderNumber: '+18327775620',
    defaultOn: false,
    brandLabel: 'LaniHost',
  };

  it('defaults to disabled when nothing is configured', () => {
    const resolved = resolveSmsSettings({ organisationSettings: null, teamSettings: null });

    expect(resolved.enabled).toBe(false);
    expect(resolved.defaultOn).toBe(false);
  });

  it('falls back to the organisation when the team has no settings', () => {
    const resolved = resolveSmsSettings({ organisationSettings, teamSettings: null });

    expect(resolved.brandLabel).toBe('LaniHost');
    expect(resolved.enabled).toBe(true);
  });

  it('lets the team override the organisation', () => {
    const resolved = resolveSmsSettings({
      organisationSettings,
      teamSettings: {
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      },
    });

    expect(resolved.brandLabel).toBe('EverTrade');
    expect(resolved.defaultOn).toBe(true);
  });

  it('treats malformed stored settings as disabled rather than throwing', () => {
    const resolved = resolveSmsSettings({
      organisationSettings: { enabled: 'yes' },
      teamSettings: null,
    });

    expect(resolved.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-settings`
Expected: FAIL, `Failed to resolve import "./sms-settings"`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/types/sms-settings.ts`:

```ts
import { z } from 'zod';

import { SMS_E164_PATTERN } from '../constants/sms-delivery';

export const ZSmsSettingsSchema = z.object({
  enabled: z.boolean(),
  senderNumber: z.string().regex(SMS_E164_PATTERN, 'Sender number must be in E.164 format'),
  defaultOn: z.boolean(),
  brandLabel: z.string().min(1).max(24),
});

export type TSmsSettings = z.infer<typeof ZSmsSettingsSchema>;

export const SMS_SETTINGS_DISABLED: TSmsSettings = {
  enabled: false,
  senderNumber: '+10000000000',
  defaultOn: false,
  brandLabel: 'Documenso',
};

/**
 * Team settings override organisation settings. Anything unparseable resolves
 * to disabled, so a corrupt row cannot cause an unintended send.
 */
export const resolveSmsSettings = (options: {
  organisationSettings: unknown;
  teamSettings: unknown;
}): TSmsSettings => {
  const team = ZSmsSettingsSchema.safeParse(options.teamSettings);

  if (team.success) {
    return team.data;
  }

  const organisation = ZSmsSettingsSchema.safeParse(options.organisationSettings);

  if (organisation.success) {
    return organisation.data;
  }

  return SMS_SETTINGS_DISABLED;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-settings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/types/sms-settings.ts packages/lib/types/sms-settings.test.ts
git commit -m "feat(sms): add team sms settings schema and resolution"
```

---

### Task 5: Database schema

**Files:**
- Modify: `packages/prisma/schema.prisma` (Recipient at line 650, ScheduledReminderDelivery at line 697, TeamGlobalSettings at line 1092, OrganisationGlobalSettings at line 1050)
- Create: a generated migration under `packages/prisma/migrations/`

**Interfaces:**
- Consumes: `ZSmsSettingsSchema` from Task 4, referenced in the Prisma doc comment the same way `reminderSettings` references `ZEnvelopeReminderSettingsSchema`.
- Produces: `Recipient.phone`, `ScheduledReminderDelivery.channel`, `ScheduledReminderDelivery.kind`, `SmsOptOut`, and `smsSettings` on both settings models. Every later plan reads these.

This task has no unit test. Its verification is that the migration applies and the client regenerates, which Step 4 checks.

- [ ] **Step 1: Start the development database**

Run: `npm run dx:up`
Expected: the `docker/development/compose.yml` Postgres container reports healthy.

- [ ] **Step 2: Edit the schema**

In `packages/prisma/schema.prisma`, add to `model Recipient`, directly beneath the `email` field:

```prisma
  phone                       String?                     @db.VarChar(20)
```

Add to `model ScheduledReminderDelivery`, directly beneath the `status` field:

```prisma
  channel          NotificationChannel             @default(EMAIL)
  kind             ScheduledReminderDeliveryKind   @default(REMINDER)
```

Add these enums beside the existing `ScheduledReminderDeliveryStatus` enum near line 632:

```prisma
enum NotificationChannel {
  EMAIL
  SMS
}

enum ScheduledReminderDeliveryKind {
  SIGNING_REQUEST
  REMINDER
  COMPLETION
}

enum SmsOptOutReason {
  STOP
  MANUAL
  PROVIDER_PERMANENT
}
```

Add the suppression model beside the other top-level models:

```prisma
model SmsOptOut {
  id        String          @id @default(cuid())
  phone     String          @db.VarChar(20)
  teamId    Int
  reason    SmsOptOutReason
  createdAt DateTime        @default(now())

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([phone, teamId])
  @@index([teamId])
}
```

Add the back-relation to `model Team`:

```prisma
  smsOptOuts SmsOptOut[]
```

Add to **both** `model TeamGlobalSettings` and `model OrganisationGlobalSettings`, beside the existing `reminderSettings` line:

```prisma
  smsSettings Json? /// [SmsSettings] @zod.custom.use(ZSmsSettingsSchema)
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run prisma:migrate-dev -- --name add_sms_delivery_channel`
Expected: a new directory under `packages/prisma/migrations/` and "Your database is now in sync with your schema".

- [ ] **Step 4: Verify the generated client**

Run: `npm run prisma:generate`
Expected: success. Then confirm the enums exist:

```bash
grep -n "NotificationChannel\|SmsOptOutReason" node_modules/.prisma/client/index.d.ts | head -5
```

Expected: both enum names appear.

- [ ] **Step 5: Confirm existing rows kept their meaning**

The defaults `EMAIL` and `REMINDER` mean every pre-existing ledger row still describes an email reminder. Verify no row was left null:

```bash
npm run prisma:studio
```

Expected: existing `ScheduledReminderDelivery` rows show channel `EMAIL` and kind `REMINDER`. Close Studio when done.

- [ ] **Step 6: Commit**

```bash
git add packages/prisma/schema.prisma packages/prisma/migrations
git commit -m "feat(sms): add sms channel, recipient phone, and opt-out schema"
```

---

### Task 6: Opt-out suppression

**Files:**
- Create: `packages/lib/server-only/sms/sms-opt-out.ts`
- Test: `packages/lib/server-only/sms/sms-opt-out.test.ts`

**Interfaces:**
- Consumes: `normalisePhoneNumber` from Task 1, the `SmsOptOut` model from Task 5.
- Produces: `isPhoneSuppressed(options: { phone: string; teamId: number }): Promise<boolean>`, `suppressPhone(options: { phone: string; teamId: number; reason: SmsOptOutReason }): Promise<void>`. The transport in Task 7 calls `isPhoneSuppressed` before every send and `suppressPhone` on an opt-out error.

Suppression is scoped per team, because opting out of one brand does not opt out of another. Both functions normalize before touching the database, so a number stored from a webhook in one format still matches a send in another.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/sms-opt-out.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    smsOptOut: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

const { isPhoneSuppressed, suppressPhone } = await import('./sms-opt-out');

describe('isPhoneSuppressed', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('returns true when a suppression row exists', async () => {
    findUnique.mockResolvedValue({ id: 'opt-1' });

    await expect(isPhoneSuppressed({ phone: '+18325551234', teamId: 3 })).resolves.toBe(true);
  });

  it('returns false when no row exists', async () => {
    findUnique.mockResolvedValue(null);

    await expect(isPhoneSuppressed({ phone: '+18325551234', teamId: 3 })).resolves.toBe(false);
  });

  it('normalises before querying so formats cannot bypass suppression', async () => {
    findUnique.mockResolvedValue({ id: 'opt-1' });

    await isPhoneSuppressed({ phone: '(832) 555-1234', teamId: 3 });

    expect(findUnique).toHaveBeenCalledWith({
      where: { phone_teamId: { phone: '+18325551234', teamId: 3 } },
      select: { id: true },
    });
  });

  it('treats an unusable number as suppressed rather than sending to it', async () => {
    await expect(isPhoneSuppressed({ phone: 'not a phone', teamId: 3 })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('suppressPhone', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('upserts so a repeated STOP does not throw', async () => {
    await suppressPhone({ phone: '+18325551234', teamId: 3, reason: 'STOP' });

    expect(upsert).toHaveBeenCalledWith({
      where: { phone_teamId: { phone: '+18325551234', teamId: 3 } },
      create: { phone: '+18325551234', teamId: 3, reason: 'STOP' },
      update: { reason: 'STOP' },
    });
  });

  it('ignores an unusable number', async () => {
    await suppressPhone({ phone: 'garbage', teamId: 3, reason: 'STOP' });

    expect(upsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-opt-out`
Expected: FAIL, `Failed to resolve import "./sms-opt-out"`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/sms-opt-out.ts`:

```ts
import { prisma } from '@documenso/prisma';
import type { SmsOptOutReason } from '@prisma/client';

import { normalisePhoneNumber } from '../../constants/sms-delivery';

/**
 * An unusable number resolves to suppressed. Failing closed means a malformed
 * value is skipped rather than handed to the provider.
 */
export const isPhoneSuppressed = async (options: {
  phone: string;
  teamId: number;
}): Promise<boolean> => {
  const phone = normalisePhoneNumber(options.phone);

  if (!phone) {
    return true;
  }

  const suppression = await prisma.smsOptOut.findUnique({
    where: { phone_teamId: { phone, teamId: options.teamId } },
    select: { id: true },
  });

  return suppression !== null;
};

export const suppressPhone = async (options: {
  phone: string;
  teamId: number;
  reason: SmsOptOutReason;
}): Promise<void> => {
  const phone = normalisePhoneNumber(options.phone);

  if (!phone) {
    return;
  }

  await prisma.smsOptOut.upsert({
    where: { phone_teamId: { phone, teamId: options.teamId } },
    create: { phone, teamId: options.teamId, reason: options.reason },
    update: { reason: options.reason },
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- sms-opt-out`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/sms-opt-out.ts packages/lib/server-only/sms/sms-opt-out.test.ts
git commit -m "feat(sms): add per-team opt-out suppression"
```

---

### Task 7: Twilio transport

**Files:**
- Create: `packages/lib/server-only/sms/send-sms.ts`
- Test: `packages/lib/server-only/sms/send-sms.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `SmsSendError` from Task 2, `isPhoneSuppressed` and `suppressPhone` from Task 6, `isTwilioOptOutError` from Task 2.
- Produces: `sendSms(options: SendSmsOptions): Promise<SendSmsResult>` where `SendSmsOptions` is `{ to: string; from: string; body: string; teamId: number; statusCallbackUrl?: string }` and `SendSmsResult` is `{ status: 'sent'; providerMessageId: string } | { status: 'suppressed' }`. The delivery worker in the next plan calls this and maps the result onto ledger fields, using `providerMessageId` as the Twilio SID.

A thrown `SmsSendError` is the failure path. The caller classifies it with `isTwilioErrorTerminal`.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/send-sms.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isPhoneSuppressed = vi.fn();
const suppressPhone = vi.fn();

vi.mock('./sms-opt-out', () => ({
  isPhoneSuppressed: (...args: unknown[]) => isPhoneSuppressed(...args),
  suppressPhone: (...args: unknown[]) => suppressPhone(...args),
}));

const { sendSms } = await import('./send-sms');
const { SmsSendError } = await import('../../constants/sms-delivery');

const baseOptions = {
  to: '+18325551234',
  from: '+18327775620',
  body: 'EverTrade: you have a document to sign.',
  teamId: 3,
};

describe('sendSms', () => {
  beforeEach(() => {
    isPhoneSuppressed.mockResolvedValue(false);
    suppressPhone.mockReset();
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns suppressed without calling twilio when the number opted out', async () => {
    isPhoneSuppressed.mockResolvedValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms(baseOptions)).resolves.toEqual({ status: 'suppressed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a form encoded body and returns the twilio sid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SM123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms(baseOptions)).resolves.toEqual({
      status: 'sent',
      providerMessageId: 'SM123',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('AC_test:token_test')}`);
    expect(init.body.toString()).toContain('To=%2B18325551234');
    expect(init.body.toString()).toContain('From=%2B18327775620');
  });

  it('throws SmsSendError carrying the twilio code on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 21211, message: 'Invalid To number' }),
      }),
    );

    await expect(sendSms(baseOptions)).rejects.toBeInstanceOf(SmsSendError);
  });

  it('records a suppression when twilio reports an unsubscribed recipient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 21610, message: 'Unsubscribed recipient' }),
      }),
    );

    await expect(sendSms(baseOptions)).rejects.toBeInstanceOf(SmsSendError);
    expect(suppressPhone).toHaveBeenCalledWith({
      phone: '+18325551234',
      teamId: 3,
      reason: 'PROVIDER_PERMANENT',
    });
  });

  it('throws when credentials are missing rather than silently skipping', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;

    await expect(sendSms(baseOptions)).rejects.toThrow('TWILIO_ACCOUNT_SID');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- send-sms`
Expected: FAIL, `Failed to resolve import "./send-sms"`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/send-sms.ts`:

```ts
import { SmsSendError } from '../../constants/sms-delivery';
import { isPhoneSuppressed, suppressPhone } from './sms-opt-out';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export type SendSmsOptions = {
  to: string;
  from: string;
  body: string;
  teamId: number;
  statusCallbackUrl?: string;
};

export type SendSmsResult = { status: 'sent'; providerMessageId: string } | { status: 'suppressed' };

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
};

export const sendSms = async (options: SendSmsOptions): Promise<SendSmsResult> => {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');

  if (await isPhoneSuppressed({ phone: options.to, teamId: options.teamId })) {
    return { status: 'suppressed' };
  }

  const form = new URLSearchParams({
    To: options.to,
    From: options.from,
    Body: options.body,
  });

  if (options.statusCallbackUrl) {
    form.set('StatusCallback', options.statusCallbackUrl);
  }

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const payload = await response.json();

  if (!response.ok) {
    const error = new SmsSendError(payload?.message ?? 'Twilio rejected the message', {
      code: typeof payload?.code === 'number' ? payload.code : 0,
      status: response.status,
    });

    // A provider-side unsubscribe is authoritative. Record it so the next send
    // is skipped locally instead of billing another rejected request.
    if (error.code === 21610) {
      await suppressPhone({ phone: options.to, teamId: options.teamId, reason: 'PROVIDER_PERMANENT' });
    }

    throw error;
  }

  return { status: 'sent', providerMessageId: payload.sid };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- send-sms`
Expected: PASS, 5 tests.

- [ ] **Step 5: Document the environment variables**

Append to `.env.example`:

```bash
# SMS notifications (Twilio). Leave unset to disable SMS entirely.
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
TWILIO_STATUS_CALLBACK_URL=""
```

- [ ] **Step 6: Verify the whole suite and lint**

Run: `npm run test -w @documenso/lib`
Expected: PASS, including the pre-existing reminder tests.

Run: `npm run lint`
Expected: no findings in the new files.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/server-only/sms/send-sms.ts packages/lib/server-only/sms/send-sms.test.ts .env.example
git commit -m "feat(sms): add twilio transport with suppression checks"
```

---

## Verification

After Task 7 the following is true and provable:

- `npm run test -w @documenso/lib` passes, covering normalization, error classification, message building, settings resolution, suppression, and transport.
- The migration applies cleanly and existing ledger rows read as `EMAIL` / `REMINDER`.
- No credential appears anywhere in the repository. Confirm with:

```bash
git log -p origin/lanihost/main..HEAD | grep -iE "AC[0-9a-f]{32}|auth_token|\+1[0-9]{10}" | grep -v "example\|test\|8325551234\|8327775620"
```

Expected: no output. The two numbers excluded are the documented test fixtures.

Nothing sends a real message yet. No user-facing surface changed.

## Subsequent plans

Written after this one lands, so each is based on merged interfaces rather than predicted ones:

1. **Compliance webhooks.** Inbound Twilio message handler for STOP and HELP, the status callback that drives the existing `provider*` ledger fields, and Twilio request-signature verification on both. This lands before triggers, so opt-out works before anything can text a customer.
2. **Triggers.** Channel support in `process-scheduled-reminder-delivery.ts`, plus SMS on initial send, manual resend, and completion. Governed by the team setting only, still no UI.
3. **User interface.** The phone field and toggle in `envelope-distribute-dialog.tsx`, the channel choice in `envelope-redistribute-dialog.tsx`, the settings section in `document-preferences-form.tsx`, and SMS state on the document view.
4. **Operations.** Extend `ops/documenso-monitor.py` to the SMS channel, write `docs/lanihost-sms-notifications.md`, and update `PUBLIC-SOURCE-NOTICE.md`.
