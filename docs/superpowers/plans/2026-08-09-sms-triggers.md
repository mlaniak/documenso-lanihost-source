# SMS Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four trigger points actually produce text messages, so a signer receives an SMS alongside every email.

**Architecture:** Triggers do not call `sendSms` directly. They enqueue a `ScheduledReminderDelivery` row with `channel: SMS` and the appropriate `kind`, and the existing five-minute sweep plus worker deliver it with retries, audit entries, and provider status tracking already built. The worker gains a channel branch; everything else already works.

**Tech Stack:** TypeScript, Prisma, Vitest, the existing Documenso job system.

## Global Constraints

- Prerequisites: the delivery core and compliance webhooks plans are merged. This consumes `sendSms`, `buildSigningRequestSms`, `buildCompletionSms`, `DEFAULT_SMS_COPY`, `isRecipientSmsQuotaExceeded`, and the `channel` / `kind` ledger columns.
- Branch: `agent/sms-notifications`.
- **Email behaviour must not change.** Every edit to an existing send path is additive. If SMS enqueueing throws, the email must still go out — wrap every trigger call site so a failure is logged, not propagated.
- **No new npm dependencies.**
- Tests: Vitest, colocated. Run `npm run test -w @documenso/lib`.
- **Run the real build before committing the final task:** `npm run build --workspace @documenso/remix` with `NEXT_PRIVATE_DATABASE_URL`, `NEXT_PRIVATE_DIRECT_DATABASE_URL`, and `NEXT_PUBLIC_WEBAPP_URL` set to placeholders. Vitest does not typecheck; the build is the only thing that catches a Prisma type mismatch.
- The build rewrites `packages/lib/translations/*.po` via `lingui extract`. Run `git checkout -- packages/lib/translations` before staging.
- Commits are Conventional Commits. Commit after every task.

## Two findings that shaped this plan

**The worker would cancel every completion text.** `processScheduledReminderDelivery` computes `isEligible` as envelope `PENDING` **and** recipient `NOT_SIGNED`. A completion message is by definition sent when the envelope is `COMPLETED` and the recipient *has* signed, so every `COMPLETION` row would be cancelled on its first claim. Task 1 makes eligibility kind-aware. The sweep itself needs no change: its ledger query filters only on status and due time.

**`resolveSmsSettings` reimplements inheritance the codebase already does.** `extractDerivedTeamSettings` in `packages/lib/utils/teams.ts` generically walks every settings key and prefers the non-null team value, so `getTeamSettings({ teamId })` already returns `smsSettings` correctly inherited. Task 2 reduces the resolver to a fail-closed parse over that derived value instead of a second inheritance implementation.

---

### Task 1: Kind-aware delivery eligibility

**Files:**
- Modify: `packages/lib/constants/scheduled-reminder-delivery.ts`
- Test: `packages/lib/constants/scheduled-reminder-delivery.test.ts`

**Interfaces:**
- Produces: `isScheduledDeliveryEligible(options: { kind: ScheduledReminderDeliveryKind; envelopeStatus: DocumentStatus; envelopeDeletedAt: Date | null; signingStatus: SigningStatus; role: RecipientRole; expiresAt: Date | null; now: Date }): boolean`. Task 4 replaces the worker's inline check with this.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/constants/scheduled-reminder-delivery.test.ts`:

```ts
import { isScheduledDeliveryEligible } from './scheduled-reminder-delivery';

describe('isScheduledDeliveryEligible', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');

  const pendingSigner = {
    envelopeStatus: 'PENDING' as const,
    envelopeDeletedAt: null,
    signingStatus: 'NOT_SIGNED' as const,
    role: 'SIGNER' as const,
    expiresAt: null,
    now,
  };

  it.each([['SIGNING_REQUEST' as const], ['REMINDER' as const]])(
    'allows %s for an unsigned recipient on a pending envelope',
    (kind) => {
      expect(isScheduledDeliveryEligible({ ...pendingSigner, kind })).toBe(true);
    },
  );

  it.each([['SIGNING_REQUEST' as const], ['REMINDER' as const]])(
    'blocks %s once the recipient has signed',
    (kind) => {
      expect(
        isScheduledDeliveryEligible({ ...pendingSigner, kind, signingStatus: 'SIGNED' }),
      ).toBe(false);
    },
  );

  it('blocks a reminder to a CC recipient', () => {
    expect(isScheduledDeliveryEligible({ ...pendingSigner, kind: 'REMINDER', role: 'CC' })).toBe(
      false,
    );
  });

  it('blocks a reminder past the recipient expiry', () => {
    expect(
      isScheduledDeliveryEligible({
        ...pendingSigner,
        kind: 'REMINDER',
        expiresAt: new Date('2026-08-09T11:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('allows COMPLETION on a completed envelope for a signed recipient', () => {
    expect(
      isScheduledDeliveryEligible({
        ...pendingSigner,
        kind: 'COMPLETION',
        envelopeStatus: 'COMPLETED',
        signingStatus: 'SIGNED',
      }),
    ).toBe(true);
  });

  it('blocks COMPLETION while the envelope is still pending', () => {
    expect(isScheduledDeliveryEligible({ ...pendingSigner, kind: 'COMPLETION' })).toBe(false);
  });

  it('blocks everything on a deleted envelope', () => {
    expect(
      isScheduledDeliveryEligible({
        ...pendingSigner,
        kind: 'REMINDER',
        envelopeDeletedAt: new Date('2026-08-08T00:00:00.000Z'),
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- scheduled-reminder-delivery`
Expected: FAIL, `isScheduledDeliveryEligible is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/lib/constants/scheduled-reminder-delivery.ts`:

```ts
import type {
  DocumentStatus,
  RecipientRole,
  ScheduledReminderDeliveryKind,
  SigningStatus,
} from '@prisma/client';

/**
 * A completion message is sent precisely when a signing request must not be:
 * the envelope is finished and the recipient has signed. Eligibility therefore
 * cannot be one rule for every kind.
 */
export const isScheduledDeliveryEligible = (options: {
  kind: ScheduledReminderDeliveryKind;
  envelopeStatus: DocumentStatus;
  envelopeDeletedAt: Date | null;
  signingStatus: SigningStatus;
  role: RecipientRole;
  expiresAt: Date | null;
  now: Date;
}): boolean => {
  if (options.envelopeDeletedAt !== null) {
    return false;
  }

  if (options.role === 'CC') {
    return false;
  }

  if (options.kind === 'COMPLETION') {
    return options.envelopeStatus === 'COMPLETED' && options.signingStatus === 'SIGNED';
  }

  return (
    options.envelopeStatus === 'PENDING' &&
    options.signingStatus === 'NOT_SIGNED' &&
    (!options.expiresAt || options.expiresAt > options.now)
  );
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- scheduled-reminder-delivery`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/constants/scheduled-reminder-delivery.ts packages/lib/constants/scheduled-reminder-delivery.test.ts
git commit -m "feat(sms): make delivery eligibility kind aware"
```

---

### Task 2: Envelope SMS context

**Files:**
- Modify: `packages/lib/types/sms-settings.ts`
- Modify: `packages/lib/types/sms-settings.test.ts`
- Create: `packages/lib/server-only/sms/get-envelope-sms-context.ts`
- Test: `packages/lib/server-only/sms/get-envelope-sms-context.test.ts`

**Interfaces:**
- Produces: `parseSmsSettings(value: unknown): TSmsSettings` (replacing the two-argument `resolveSmsSettings`) and `getEnvelopeSmsContext(options: { teamId: number; documentSmsEnabled: boolean | null }): Promise<{ enabled: boolean; settings: TSmsSettings }>`. Tasks 3 and 5 through 7 use the context to decide whether to enqueue.

`enabled` is true only when the resolved settings are enabled **and** the envelope-level toggle allows it. The envelope override wins when non-null; otherwise `defaultOn` decides.

- [ ] **Step 1: Replace the resolver with a fail-closed parse**

In `packages/lib/types/sms-settings.ts`, delete `resolveSmsSettings` and add:

```ts
/**
 * `getTeamSettings` already merges organisation and team values through
 * `extractDerivedTeamSettings`, so this only has to fail closed on anything
 * unparseable rather than reimplement inheritance.
 */
export const parseSmsSettings = (value: unknown): TSmsSettings => {
  const parsed = ZSmsSettingsSchema.safeParse(value);

  return parsed.success ? parsed.data : SMS_SETTINGS_DISABLED;
};
```

In `packages/lib/types/sms-settings.test.ts`, replace the entire `describe('resolveSmsSettings', ...)` block with:

```ts
describe('parseSmsSettings', () => {
  it('returns the parsed settings when valid', () => {
    const parsed = parseSmsSettings({
      enabled: true,
      senderNumber: '+18327775620',
      defaultOn: true,
      brandLabel: 'EverTrade',
    });

    expect(parsed.brandLabel).toBe('EverTrade');
  });

  it('falls back to disabled for null', () => {
    expect(parseSmsSettings(null).enabled).toBe(false);
  });

  it('falls back to disabled for a malformed value rather than throwing', () => {
    expect(parseSmsSettings({ enabled: 'yes' }).enabled).toBe(false);
  });
});
```

Update the import at the top of that test file from `resolveSmsSettings` to `parseSmsSettings`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- sms-settings`
Expected: FAIL, `parseSmsSettings is not exported`, then PASS once Step 1's implementation is saved. If it already passes, confirm both edits were saved.

- [ ] **Step 3: Write the context test**

Create `packages/lib/server-only/sms/get-envelope-sms-context.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTeamSettings = vi.fn();

vi.mock('../team/get-team-settings', () => ({
  getTeamSettings: (...args: unknown[]) => getTeamSettings(...args),
}));

const { getEnvelopeSmsContext } = await import('./get-envelope-sms-context');

const enabledSettings = {
  enabled: true,
  senderNumber: '+18327775620',
  defaultOn: true,
  brandLabel: 'EverTrade',
};

describe('getEnvelopeSmsContext', () => {
  beforeEach(() => {
    getTeamSettings.mockReset().mockResolvedValue({ smsSettings: enabledSettings });
  });

  it('is enabled when the team default is on and the envelope does not override', async () => {
    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: null });

    expect(context.enabled).toBe(true);
    expect(context.settings.senderNumber).toBe('+18327775620');
  });

  it('lets the envelope turn it off', async () => {
    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: false });

    expect(context.enabled).toBe(false);
  });

  it('lets the envelope turn it on when the team default is off', async () => {
    getTeamSettings.mockResolvedValue({
      smsSettings: { ...enabledSettings, defaultOn: false },
    });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(true);
  });

  it('stays disabled when the team has SMS switched off entirely, whatever the envelope says', async () => {
    getTeamSettings.mockResolvedValue({
      smsSettings: { ...enabledSettings, enabled: false },
    });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(false);
  });

  it('is disabled when the team has no sms settings', async () => {
    getTeamSettings.mockResolvedValue({ smsSettings: null });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(false);
  });
});
```

- [ ] **Step 4: Write the context implementation**

Create `packages/lib/server-only/sms/get-envelope-sms-context.ts`:

```ts
import { parseSmsSettings, type TSmsSettings } from '../../types/sms-settings';
import { getTeamSettings } from '../team/get-team-settings';

export type EnvelopeSmsContext = {
  enabled: boolean;
  settings: TSmsSettings;
};

/**
 * The team switch is a hard gate. The envelope toggle only chooses within a
 * team that has SMS turned on, so an envelope can never enable texting for a
 * team that has not configured a sender number.
 */
export const getEnvelopeSmsContext = async (options: {
  teamId: number;
  documentSmsEnabled: boolean | null;
}): Promise<EnvelopeSmsContext> => {
  const teamSettings = await getTeamSettings({ teamId: options.teamId });
  const settings = parseSmsSettings(teamSettings.smsSettings);

  const enabled = settings.enabled && (options.documentSmsEnabled ?? settings.defaultOn);

  return { enabled, settings };
};
```

- [ ] **Step 5: Run both tests**

Run: `npm run test -w @documenso/lib -- sms-settings get-envelope-sms-context`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/types/sms-settings.ts packages/lib/types/sms-settings.test.ts packages/lib/server-only/sms/get-envelope-sms-context.ts packages/lib/server-only/sms/get-envelope-sms-context.test.ts
git commit -m "feat(sms): resolve per-envelope sms context from team settings"
```

---

### Task 3: Enqueue an SMS delivery

**Files:**
- Create: `packages/lib/server-only/sms/enqueue-sms-delivery.ts`
- Test: `packages/lib/server-only/sms/enqueue-sms-delivery.test.ts`

**Interfaces:**
- Consumes: `getEnvelopeSmsContext` (Task 2), `normalisePhoneNumber`, `isPhoneSuppressed`.
- Produces: `enqueueSmsDelivery(options: { envelopeId: string; recipientId: number; teamId: number; documentSmsEnabled: boolean | null; kind: ScheduledReminderDeliveryKind; createdById: number | null; scheduledAt?: Date }): Promise<'enqueued' | 'skipped'>`. Every trigger in Tasks 5 through 7 calls this.

It never throws for an expected reason. No phone, SMS disabled, or a suppressed number all return `'skipped'`, because a missing text must never fail a send.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/enqueue-sms-delivery.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvelopeSmsContext = vi.fn();
const isPhoneSuppressed = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();

vi.mock('./get-envelope-sms-context', () => ({
  getEnvelopeSmsContext: (...args: unknown[]) => getEnvelopeSmsContext(...args),
}));

vi.mock('./sms-opt-out', () => ({
  isPhoneSuppressed: (...args: unknown[]) => isPhoneSuppressed(...args),
  suppressPhone: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findUnique: (...args: unknown[]) => findUnique(...args) },
    scheduledReminderDelivery: { create: (...args: unknown[]) => create(...args) },
  },
}));

const { enqueueSmsDelivery } = await import('./enqueue-sms-delivery');

const baseOptions = {
  envelopeId: 'env-1',
  recipientId: 5,
  teamId: 7,
  documentSmsEnabled: null,
  kind: 'SIGNING_REQUEST' as const,
  createdById: 2,
};

describe('enqueueSmsDelivery', () => {
  beforeEach(() => {
    getEnvelopeSmsContext.mockReset().mockResolvedValue({
      enabled: true,
      settings: {
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      },
    });
    isPhoneSuppressed.mockReset().mockResolvedValue(false);
    findUnique.mockReset().mockResolvedValue({ phone: '+18325551234' });
    create.mockReset().mockResolvedValue({ id: 'delivery-1' });
  });

  it('creates an sms ledger row due immediately', async () => {
    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('enqueued');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: 'SMS',
          kind: 'SIGNING_REQUEST',
          envelopeId: 'env-1',
          recipientId: 5,
          status: 'PENDING',
        }),
      }),
    );
  });

  it('skips when sms is disabled for the envelope', async () => {
    getEnvelopeSmsContext.mockResolvedValue({ enabled: false, settings: {} });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the recipient has no phone number', async () => {
    findUnique.mockResolvedValue({ phone: null });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the number is unusable', async () => {
    findUnique.mockResolvedValue({ phone: 'not a number' });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a suppressed number without creating a row', async () => {
    isPhoneSuppressed.mockResolvedValue(true);

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the recipient no longer exists', async () => {
    findUnique.mockResolvedValue(null);

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- enqueue-sms-delivery`
Expected: FAIL, `Cannot find module './enqueue-sms-delivery'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/enqueue-sms-delivery.ts`:

```ts
import { prisma } from '@documenso/prisma';
import type { ScheduledReminderDeliveryKind } from '@prisma/client';

import { normalisePhoneNumber } from '../../constants/sms-delivery';
import { getEnvelopeSmsContext } from './get-envelope-sms-context';
import { isPhoneSuppressed } from './sms-opt-out';

export type EnqueueSmsDeliveryOptions = {
  envelopeId: string;
  recipientId: number;
  teamId: number;
  documentSmsEnabled: boolean | null;
  kind: ScheduledReminderDeliveryKind;
  createdById: number | null;
  scheduledAt?: Date;
};

/**
 * Returns 'skipped' for every expected reason a text should not go out. A
 * missing text must never fail the email it accompanies, so callers treat the
 * result as informational rather than branching on it.
 */
export const enqueueSmsDelivery = async (
  options: EnqueueSmsDeliveryOptions,
): Promise<'enqueued' | 'skipped'> => {
  const context = await getEnvelopeSmsContext({
    teamId: options.teamId,
    documentSmsEnabled: options.documentSmsEnabled,
  });

  if (!context.enabled) {
    return 'skipped';
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: options.recipientId },
    select: { phone: true },
  });

  const phone = recipient?.phone ? normalisePhoneNumber(recipient.phone) : null;

  if (!phone) {
    return 'skipped';
  }

  if (await isPhoneSuppressed({ phone, teamId: options.teamId })) {
    return 'skipped';
  }

  const scheduledAt = options.scheduledAt ?? new Date();

  await prisma.scheduledReminderDelivery.create({
    data: {
      channel: 'SMS',
      kind: options.kind,
      status: 'PENDING',
      scheduledAt,
      nextAttemptAt: scheduledAt,
      envelopeId: options.envelopeId,
      recipientId: options.recipientId,
      createdById: options.createdById,
    },
  });

  return 'enqueued';
};
```

If `createdById` is non-nullable in the generated Prisma types, pass the envelope owner's id from the call site instead of null and update this signature to `createdById: number`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- enqueue-sms-delivery`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/server-only/sms/enqueue-sms-delivery.ts packages/lib/server-only/sms/enqueue-sms-delivery.test.ts
git commit -m "feat(sms): enqueue sms deliveries onto the reminder ledger"
```

---

### Task 4: Worker channel branch

**Files:**
- Modify: `packages/lib/jobs/definitions/internal/process-scheduled-reminder-delivery.ts`
- Create: `packages/lib/server-only/sms/deliver-sms-for-delivery.ts`
- Test: `packages/lib/server-only/sms/deliver-sms-for-delivery.test.ts`

**Interfaces:**
- Consumes: `sendSms`, `buildSigningRequestSms`, `buildCompletionSms`, `getEnvelopeSmsContext`, `formatSigningLink` from `packages/lib/utils/recipients.ts`.
- Produces: `deliverSmsForDelivery(options: { delivery: { id: string; kind: ScheduledReminderDeliveryKind; recipientId: number }; recipient: { phone: string | null; token: string }; envelope: { id: string; title: string; teamId: number }; documentSmsEnabled: boolean | null }): Promise<SendSmsResult>`. The worker calls this instead of `resendDocument` when `channel === 'SMS'`.

Keeping delivery in its own module keeps the worker edit to a few lines, which matters for rebasing.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/server-only/sms/deliver-sms-for-delivery.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendSms = vi.fn();
const getEnvelopeSmsContext = vi.fn();

vi.mock('./send-sms', () => ({ sendSms: (...args: unknown[]) => sendSms(...args) }));

vi.mock('./get-envelope-sms-context', () => ({
  getEnvelopeSmsContext: (...args: unknown[]) => getEnvelopeSmsContext(...args),
}));

const { deliverSmsForDelivery } = await import('./deliver-sms-for-delivery');

const baseArgs = {
  delivery: { id: 'delivery-1', kind: 'SIGNING_REQUEST' as const, recipientId: 5 },
  recipient: { phone: '+18325551234', token: 'tok123' },
  envelope: { id: 'env-1', title: 'Employment Agreement', teamId: 7 },
  documentSmsEnabled: null,
};

describe('deliverSmsForDelivery', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
    sendSms.mockReset().mockResolvedValue({ status: 'sent', providerMessageId: 'SM1' });
    getEnvelopeSmsContext.mockReset().mockResolvedValue({
      enabled: true,
      settings: {
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      },
    });
  });

  it('sends a signing request containing the signing link', async () => {
    await deliverSmsForDelivery(baseArgs);

    const [options] = sendSms.mock.calls[0];
    expect(options.to).toBe('+18325551234');
    expect(options.from).toBe('+18327775620');
    expect(options.body).toContain('https://documenso.lanihost.com/sign/tok123');
    expect(options.body).toContain('EverTrade');
    expect(options.recipientId).toBe(5);
  });

  it('sends a completion message naming the document', async () => {
    await deliverSmsForDelivery({
      ...baseArgs,
      delivery: { ...baseArgs.delivery, kind: 'COMPLETION' },
    });

    const [options] = sendSms.mock.calls[0];
    expect(options.body).toContain('Employment Agreement');
    expect(options.body).not.toContain('/sign/');
  });

  it('throws when sms became disabled between enqueue and delivery', async () => {
    getEnvelopeSmsContext.mockResolvedValue({ enabled: false, settings: {} });

    await expect(deliverSmsForDelivery(baseArgs)).rejects.toThrow('disabled');
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('throws when the recipient no longer has a phone number', async () => {
    await expect(
      deliverSmsForDelivery({ ...baseArgs, recipient: { phone: null, token: 'tok123' } }),
    ).rejects.toThrow('phone');
    expect(sendSms).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @documenso/lib -- deliver-sms-for-delivery`
Expected: FAIL, `Cannot find module './deliver-sms-for-delivery'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lib/server-only/sms/deliver-sms-for-delivery.ts`:

```ts
import type { ScheduledReminderDeliveryKind } from '@prisma/client';

import { buildCompletionSms, buildSigningRequestSms } from '../../constants/sms-delivery';
import { env } from '../../utils/env';
import { formatSigningLink } from '../../utils/recipients';
import { getEnvelopeSmsContext } from './get-envelope-sms-context';
import { sendSms, type SendSmsResult } from './send-sms';

export type DeliverSmsForDeliveryOptions = {
  delivery: { id: string; kind: ScheduledReminderDeliveryKind; recipientId: number };
  recipient: { phone: string | null; token: string };
  envelope: { id: string; title: string; teamId: number };
  documentSmsEnabled: boolean | null;
};

export const deliverSmsForDelivery = async (
  options: DeliverSmsForDeliveryOptions,
): Promise<SendSmsResult> => {
  // Re-checked at delivery time, not just at enqueue time: a team can switch
  // SMS off while a row sits pending.
  const context = await getEnvelopeSmsContext({
    teamId: options.envelope.teamId,
    documentSmsEnabled: options.documentSmsEnabled,
  });

  if (!context.enabled) {
    throw new Error('SMS is disabled for this envelope');
  }

  if (!options.recipient.phone) {
    throw new Error('The recipient has no phone number');
  }

  const body =
    options.delivery.kind === 'COMPLETION'
      ? buildCompletionSms({
          brandLabel: context.settings.brandLabel,
          documentTitle: options.envelope.title,
          includeOptOutNotice: false,
        })
      : buildSigningRequestSms({
          brandLabel: context.settings.brandLabel,
          signingUrl: formatSigningLink(options.recipient.token),
          includeOptOutNotice: true,
        });

  return await sendSms({
    to: options.recipient.phone,
    from: context.settings.senderNumber,
    body,
    teamId: options.envelope.teamId,
    recipientId: options.delivery.recipientId,
    statusCallbackUrl: env('TWILIO_STATUS_CALLBACK_URL') || undefined,
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @documenso/lib -- deliver-sms-for-delivery`
Expected: PASS, 4 tests.

- [ ] **Step 5: Branch the worker**

In `packages/lib/jobs/definitions/internal/process-scheduled-reminder-delivery.ts`:

Replace the inline eligibility block:

```ts
  const isEligible =
    delivery.envelope.status === DocumentStatus.PENDING &&
    delivery.envelope.deletedAt === null &&
    delivery.recipient.signingStatus === SigningStatus.NOT_SIGNED &&
    delivery.recipient.role !== RecipientRole.CC &&
    (!delivery.recipient.expiresAt || delivery.recipient.expiresAt > now);
```

with:

```ts
  const isEligible = isScheduledDeliveryEligible({
    kind: delivery.kind,
    envelopeStatus: delivery.envelope.status,
    envelopeDeletedAt: delivery.envelope.deletedAt,
    signingStatus: delivery.recipient.signingStatus,
    role: delivery.recipient.role,
    expiresAt: delivery.recipient.expiresAt,
    now,
  });
```

Add `isScheduledDeliveryEligible` to the existing import from `@documenso/lib/constants/scheduled-reminder-delivery`, and remove any now-unused `DocumentStatus`, `SigningStatus`, or `RecipientRole` imports that Biome flags.

Then replace the `await resendDocument({ ... })` call with a channel branch:

```ts
    if (delivery.channel === 'SMS') {
      const result = await deliverSmsForDelivery({
        delivery: { id: delivery.id, kind: delivery.kind, recipientId: delivery.recipientId },
        recipient: { phone: delivery.recipient.phone, token: delivery.recipient.token },
        envelope: {
          id: delivery.envelopeId,
          title: delivery.envelope.title,
          teamId: delivery.envelope.teamId,
        },
        documentSmsEnabled: delivery.envelope.documentMeta?.smsEnabled ?? null,
      });

      if (result.status !== 'sent') {
        // Suppressed and throttled are terminal, not transient: retrying would
        // produce the identical outcome and burn the attempt budget.
        await recordDeliveryFailure({
          delivery,
          error: new Error(`SMS ${result.status}`),
          isTerminal: true,
          isRetryable: false,
        });

        io.logger.info(`SMS delivery ${deliveryId} was ${result.status}`);
        return;
      }

      await prisma.scheduledReminderDelivery.update({
        where: { id: delivery.id },
        data: { providerMessageId: result.providerMessageId },
      });
    } else {
      await resendDocument({
        id: { type: 'envelopeId', id: delivery.envelopeId },
        userId: deliveryUser.id,
        teamId: delivery.envelope.teamId,
        recipients: [delivery.recipientId],
        requireEmailDelivery: true,
        emailDeliveryTracking: {
          messageId: providerMessageId,
          idempotencyKey: getScheduledReminderIdempotencyKey(delivery.id),
        },
        requestMetadata: {
          source: 'app',
          auth: 'session',
          requestMetadata: { userAgent: 'Documenso scheduled reminder delivery' },
          auditUser: deliveryUser,
        },
      });
    }
```

The email path writes `providerMessageId` before submission for Resend correlation; the SMS path writes the Twilio SID after, because the SID does not exist until the API responds. Move the existing pre-submission `providerMessageId` write inside the `else` branch so an SMS row is not stamped with an email message id.

Extend the `findUniqueOrThrow` include so the branch has what it needs: add `token: true` and `phone: true` to the recipient selection (or keep `recipient: true`), and add `documentMeta: { select: { smsEnabled: true } }` plus `title: true` to the envelope include.

- [ ] **Step 6: Run the full suite**

Run: `npm run test -w @documenso/lib`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/server-only/sms/deliver-sms-for-delivery.ts packages/lib/server-only/sms/deliver-sms-for-delivery.test.ts packages/lib/jobs/definitions/internal/process-scheduled-reminder-delivery.ts
git commit -m "feat(sms): deliver sms rows from the reminder worker"
```

---

### Task 5: Trigger on initial send

**Files:**
- Modify: `packages/lib/server-only/document/send-document.ts` (the notification block around line 342)

**Interfaces:**
- Consumes: `enqueueSmsDelivery` (Task 3).

- [ ] **Step 1: Add the enqueue alongside the email job**

In `send-document.ts`, inside the existing `recipientsToNotify.map` callback, after the `jobs.triggerJob({ name: 'send.signing.requested.email', ... })` call, add:

```ts
        // Additive and non-fatal: a failure to queue a text must never stop the
        // email that carries the same signing link.
        await enqueueSmsDelivery({
          envelopeId: envelope.id,
          recipientId: recipient.id,
          teamId,
          documentSmsEnabled: envelope.documentMeta?.smsEnabled ?? null,
          kind: 'SIGNING_REQUEST',
          createdById: userId,
        }).catch((error) => {
          console.error('Could not queue a signing request SMS', error);
        });
```

Add the import:

```ts
import { enqueueSmsDelivery } from '../sms/enqueue-sms-delivery';
```

- [ ] **Step 2: Verify the build typechecks**

Run:

```bash
NEXT_PRIVATE_DATABASE_URL="postgresql://u:p@localhost:5432/db" NEXT_PRIVATE_DIRECT_DATABASE_URL="postgresql://u:p@localhost:5432/db" NEXT_PUBLIC_WEBAPP_URL="https://documenso.lanihost.com" npm run build --workspace @documenso/remix
```

Expected: exit 0, no `error TS`. If `envelope.documentMeta` is not selected at that point in the function, add it to the enclosing query rather than reaching for a second fetch.

- [ ] **Step 3: Restore generated translations and commit**

```bash
git checkout -- packages/lib/translations
git add packages/lib/server-only/document/send-document.ts
git commit -m "feat(sms): text recipients when an envelope is sent"
```

---

### Task 6: Trigger on manual resend

**Files:**
- Modify: `packages/lib/server-only/document/resend-document.ts`

**Interfaces:**
- Consumes: `enqueueSmsDelivery` (Task 3).

The worker calls `resendDocument` for email reminders, so this call site must not enqueue an SMS when it is the worker calling. Gate on the existing `emailDeliveryTracking` option, which only the worker supplies.

- [ ] **Step 1: Add the enqueue to the user-initiated path**

In `resend-document.ts`, inside the per-recipient loop that sends the email, add:

```ts
      // emailDeliveryTracking is only supplied by the reminder worker. Without
      // this gate, an email reminder would queue a duplicate text every time it
      // ran.
      if (!emailDeliveryTracking) {
        await enqueueSmsDelivery({
          envelopeId: envelope.id,
          recipientId: recipient.id,
          teamId,
          documentSmsEnabled: envelope.documentMeta?.smsEnabled ?? null,
          kind: 'SIGNING_REQUEST',
          createdById: userId,
        }).catch((error) => {
          console.error('Could not queue a resend SMS', error);
        });
      }
```

Add the import:

```ts
import { enqueueSmsDelivery } from '../sms/enqueue-sms-delivery';
```

Confirm the destructured option is named `emailDeliveryTracking` in this file before relying on it; if it is nested, gate on the equivalent.

- [ ] **Step 2: Verify the build typechecks**

Run the same build command as Task 5, Step 2.
Expected: exit 0, no `error TS`.

- [ ] **Step 3: Restore generated translations and commit**

```bash
git checkout -- packages/lib/translations
git add packages/lib/server-only/document/resend-document.ts
git commit -m "feat(sms): text recipients on a manual resend"
```

---

### Task 7: Trigger on scheduled reminder and completion, then verify

**Files:**
- Modify: `packages/lib/server-only/document/update-document-reminder-schedule.ts`
- Modify: `packages/lib/jobs/definitions/emails/send-document-completed-emails.handler.ts`
- Modify: `docs/lanihost-sms-notifications.md`

**Interfaces:**
- Consumes: `enqueueSmsDelivery` (Task 3).

- [ ] **Step 1: Enqueue an SMS reminder beside each email reminder**

In `update-document-reminder-schedule.ts`, wherever an email `ScheduledReminderDelivery` row is created for a recipient, add a matching call:

```ts
      await enqueueSmsDelivery({
        envelopeId,
        recipientId,
        teamId,
        documentSmsEnabled: documentMeta?.smsEnabled ?? null,
        kind: 'REMINDER',
        createdById: userId,
        scheduledAt,
      }).catch((error) => {
        console.error('Could not queue a reminder SMS', error);
      });
```

Use the same `scheduledAt` the email row uses, so the two channels fire together. The one-active-per-recipient rule is per channel, so this does not collide with the email row.

- [ ] **Step 2: Enqueue a completion text**

In `send-document-completed-emails.handler.ts`, inside the loop that emails each recipient after completion, add:

```ts
      await enqueueSmsDelivery({
        envelopeId: envelope.id,
        recipientId: recipient.id,
        teamId: envelope.teamId,
        documentSmsEnabled: envelope.documentMeta?.smsEnabled ?? null,
        kind: 'COMPLETION',
        createdById: null,
      }).catch((error) => {
        console.error('Could not queue a completion SMS', error);
      });
```

If `createdById` is non-nullable, pass `envelope.userId`.

- [ ] **Step 3: Run the full suite**

Run: `npm run test -w @documenso/lib`
Expected: PASS.

- [ ] **Step 4: Run the real build**

Run the build command from Task 5, Step 2.
Expected: exit 0, no `error TS`.

- [ ] **Step 5: Update the operations document**

In `docs/lanihost-sms-notifications.md`, replace the sentence "This fork adds SMS as a second delivery channel for signing notifications, alongside email." with:

```markdown
This fork adds SMS as a second delivery channel for signing notifications,
alongside email. Four events can produce a text: the initial send, a scheduled
reminder, a manual resend, and completion. Each becomes a
`ScheduledReminderDelivery` row with `channel: SMS`, so texts inherit the same
retry backoff, stale-claim recovery, audit entries, and provider status
tracking as email reminders.

A recipient receives at most four texts per day. Anything beyond that is
recorded as throttled rather than sent.
```

- [ ] **Step 6: Restore generated translations and commit**

```bash
git checkout -- packages/lib/translations
git add packages/lib/server-only/document/update-document-reminder-schedule.ts packages/lib/jobs/definitions/emails/send-document-completed-emails.handler.ts docs/lanihost-sms-notifications.md
git commit -m "feat(sms): text recipients on scheduled reminders and completion"
```

---

## Verification

After Task 7:

- `npm run test -w @documenso/lib` passes.
- `npm run build --workspace @documenso/remix` exits 0 with no type errors.
- All four triggers enqueue an SMS row when the team has SMS enabled and the recipient has a usable, unsuppressed number.
- Every trigger is wrapped so an SMS failure cannot break the email beside it.
- A completion row is no longer cancelled by the worker's eligibility check.

## Manual verification before any customer envelope

This is the first plan whose output actually messages a person, so the live check is part of the work, not an afterthought.

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_STATUS_CALLBACK_URL` in the deployment.
2. Configure both webhook URLs on the sending number in the Twilio console.
3. Set the EverTrade team's `smsSettings` with `enabled: true`, the sender number, `defaultOn: true`, and `brandLabel: "EverTrade"`.
4. Send a test envelope to a phone you control and confirm: the text arrives, the link opens the correct signing page, the ledger row reaches `SENT`, and the status callback moves it to `DELIVERED`.
5. Reply STOP, confirm an `SmsOptOut` row appears, then send again and confirm the row records as skipped rather than sent.
6. Complete the envelope and confirm the completion text arrives.

## Not included

- UI. The phone field, the send-dialog toggle, and the settings section are the next plan. Until then, `Recipient.phone` and `smsSettings` are set through the API or directly in the database.
- Monitoring. Extending `ops/documenso-monitor.py` to the SMS channel lands with the operations plan.
