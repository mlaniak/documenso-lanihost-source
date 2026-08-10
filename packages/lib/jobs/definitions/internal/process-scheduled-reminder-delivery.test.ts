import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliverSmsForDelivery = vi.fn();
const resendDocument = vi.fn();
const updateRecipientNextReminder = vi.fn();

const claimUpdateMany = vi.fn();
const findUniqueOrThrow = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
const txUpdate = vi.fn();
const txUpdateMany = vi.fn();
const txFindFirst = vi.fn();
const txRecipientUpdateMany = vi.fn();
const txAuditCreate = vi.fn();

vi.mock('../../../server-only/sms/deliver-sms-for-delivery', () => ({
  deliverSmsForDelivery: (...args: unknown[]) => deliverSmsForDelivery(...args),
}));

vi.mock('../../../server-only/document/resend-document', () => ({
  resendDocument: (...args: unknown[]) => resendDocument(...args),
}));

vi.mock('../../../server-only/recipient/update-recipient-next-reminder', () => ({
  updateRecipientNextReminder: (...args: unknown[]) => updateRecipientNextReminder(...args),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    scheduledReminderDelivery: {
      updateMany: (...args: unknown[]) => claimUpdateMany(...args),
      findUniqueOrThrow: (...args: unknown[]) => findUniqueOrThrow(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        scheduledReminderDelivery: {
          update: (...args: unknown[]) => txUpdate(...args),
          updateMany: (...args: unknown[]) => txUpdateMany(...args),
          findFirst: (...args: unknown[]) => txFindFirst(...args),
        },
        recipient: { updateMany: (...args: unknown[]) => txRecipientUpdateMany(...args) },
        documentAuditLog: { create: (...args: unknown[]) => txAuditCreate(...args) },
      }),
  },
}));

const { processScheduledReminderDelivery } = await import('./process-scheduled-reminder-delivery');

const io = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as never;

const buildDelivery = (overrides: Record<string, unknown> = {}) => ({
  id: 'delivery-1',
  channel: 'SMS',
  kind: 'SIGNING_REQUEST',
  attemptCount: 1,
  scheduledAt: new Date('2026-08-09T10:00:00.000Z'),
  sequenceId: null,
  envelopeId: 'env-1',
  recipientId: 5,
  createdById: 2,
  createdBy: { id: 2, email: 'owner@example.com', name: 'Owner', disabled: false },
  recipient: {
    id: 5,
    email: 'signer@example.com',
    name: 'Signer',
    role: 'SIGNER',
    signingStatus: 'NOT_SIGNED',
    expiresAt: null,
    sentAt: new Date('2026-08-09T09:00:00.000Z'),
    lastReminderSentAt: null,
    reminderCount: 0,
    phone: '+18325551234',
    token: 'tok123',
  },
  envelope: {
    id: 'env-1',
    title: 'Employment Agreement',
    teamId: 7,
    status: 'PENDING',
    deletedAt: null,
    user: { id: 2, email: 'owner@example.com', name: 'Owner', disabled: false },
    documentMeta: { smsEnabled: null },
  },
  ...overrides,
});

describe('processScheduledReminderDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
    claimUpdateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ status: 'PROCESSING' });
    txFindFirst.mockResolvedValue(null);
    deliverSmsForDelivery.mockResolvedValue({ status: 'sent', providerMessageId: 'SM123' });
    updateRecipientNextReminder.mockResolvedValue(undefined);
  });

  it('delivers an sms row through the sms path, not the email path', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery());

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    expect(deliverSmsForDelivery).toHaveBeenCalledTimes(1);
    expect(resendDocument).not.toHaveBeenCalled();
  });

  it('stamps the twilio sid onto the row after a successful send', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery());

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { providerMessageId: 'SM123' },
    });
  });

  it('does not pre-stamp an email message id onto an sms row', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery());

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    const preStamped = update.mock.calls.filter(([args]) =>
      String((args as { data?: { providerMessageId?: string } }).data?.providerMessageId).startsWith('<'),
    );

    expect(preStamped).toHaveLength(0);
  });

  it('marks a suppressed send as terminally failed rather than retrying', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery());
    deliverSmsForDelivery.mockResolvedValue({ status: 'suppressed' });

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    const failed = txUpdate.mock.calls.find(
      ([args]) => (args as { data?: { status?: string } }).data?.status === 'FAILED',
    );

    expect(failed).toBeDefined();
    expect((failed?.[0] as { data: { retryable: boolean } }).data.retryable).toBe(false);
  });

  it('marks a throttled send as terminally failed', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery());
    deliverSmsForDelivery.mockResolvedValue({ status: 'throttled' });

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    const failed = txUpdate.mock.calls.find(
      ([args]) => (args as { data?: { status?: string } }).data?.status === 'FAILED',
    );

    expect(failed).toBeDefined();
  });

  it('delivers a completion row on a completed envelope instead of cancelling it', async () => {
    findUniqueOrThrow.mockResolvedValue(
      buildDelivery({
        kind: 'COMPLETION',
        recipient: { ...buildDelivery().recipient, signingStatus: 'SIGNED' },
        envelope: { ...buildDelivery().envelope, status: 'COMPLETED' },
      }),
    );

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    expect(deliverSmsForDelivery).toHaveBeenCalledTimes(1);
  });

  it('still routes an email row through resendDocument', async () => {
    findUniqueOrThrow.mockResolvedValue(buildDelivery({ channel: 'EMAIL', kind: 'REMINDER' }));

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    expect(resendDocument).toHaveBeenCalledTimes(1);
    expect(deliverSmsForDelivery).not.toHaveBeenCalled();
  });

  it('does nothing when the row was already claimed', async () => {
    claimUpdateMany.mockResolvedValue({ count: 0 });

    await processScheduledReminderDelivery({ deliveryId: 'delivery-1', io });

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(deliverSmsForDelivery).not.toHaveBeenCalled();
  });
});
