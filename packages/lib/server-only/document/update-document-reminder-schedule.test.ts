import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueuePush: vi.fn(),
  enqueue: vi.fn(),
  smsContext: vi.fn(),
  updatePhones: vi.fn(),
  metaUpdate: vi.fn(),
  envelope: vi.fn(),
  recipientUpdate: vi.fn(),
  createDelivery: vi.fn(),
  activeDeliveries: vi.fn(),
  auditCreate: vi.fn(),
}));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: { id: 'env-1', teamId: 2 } }),
}));
vi.mock('../sms/get-envelope-sms-context', () => ({ getEnvelopeSmsContext: mocks.smsContext }));
vi.mock('../notifications/document-notifications', () => ({ enqueueDocumentNotification: mocks.enqueuePush }));
vi.mock('../sms/enqueue-sms-delivery', () => ({ enqueueSmsDelivery: mocks.enqueue }));
vi.mock('../recipient/update-reminder-recipient-phones', () => ({ updateReminderRecipientPhones: mocks.updatePhones }));
vi.mock('@documenso/lib/utils/document-audit-logs', () => ({ createDocumentAuditLogData: (data: unknown) => data }));
vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirstOrThrow: async () => ({ id: 1, email: 'sender@example.com', name: 'Sender', disabled: false }) },
    envelope: { findUnique: mocks.envelope },
    recipient: { findMany: async () => [] },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        documentMeta: { update: mocks.metaUpdate },
        recipient: { update: mocks.recipientUpdate },
        scheduledReminderDelivery: { findMany: mocks.activeDeliveries, create: mocks.createDelivery },
        documentAuditLog: { create: mocks.auditCreate },
      }),
  },
}));

const { updateDocumentReminderSchedule } = await import('./update-document-reminder-schedule');
const scheduledAt = new Date('2035-01-01T15:00:00Z');
const base = { envelopeId: 'env-1', userId: 1, teamId: 2, recipients: [7], scheduledAt };

describe('scheduled reminder SMS selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueuePush.mockResolvedValue(undefined);
    mocks.smsContext.mockResolvedValue({ enabled: true });
    mocks.envelope.mockResolvedValue({
      id: 'env-1',
      status: 'PENDING',
      documentMeta: { id: 'meta-1', distributionMethod: 'EMAIL', smsEnabled: false, reminderSettings: null },
      recipients: [
        {
          id: 7,
          phone: '+18325550123',
          email: 'recipient@example.com',
          name: 'Recipient',
          role: 'SIGNER',
          signingStatus: 'NOT_SIGNED',
          sentAt: null,
        },
      ],
    });
    mocks.activeDeliveries.mockResolvedValue([]);
    mocks.createDelivery.mockResolvedValue({ id: 'delivery-1', scheduledAt });
    mocks.enqueue.mockResolvedValue('enqueued');
    mocks.updatePhones.mockResolvedValue(undefined);
  });

  it.each([true, false])('persists and forwards explicit SMS choice %s after saving phones', async (smsEnabled) => {
    const recipientPhones = [{ id: 7, phone: '8325550123' }];
    await updateDocumentReminderSchedule({ ...base, smsEnabled, recipientPhones });
    expect(mocks.updatePhones).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 'env-1', eligibleRecipientIds: [7], recipientPhones }),
    );
    expect(mocks.metaUpdate).toHaveBeenCalledWith({ where: { id: 'meta-1' }, data: { smsEnabled } });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ documentSmsEnabled: smsEnabled, recipientId: 7, scheduledAt }),
    );
    expect(mocks.updatePhones.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]);
  });

  it('does not change contact details or SMS preferences when cancelling a schedule', async () => {
    await updateDocumentReminderSchedule({ ...base, scheduledAt: null });
    expect(mocks.updatePhones).not.toHaveBeenCalled();
    expect(mocks.metaUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue SMS if phone persistence fails', async () => {
    mocks.updatePhones.mockRejectedValue(new Error('stale recipient'));
    await expect(updateDocumentReminderSchedule({ ...base, smsEnabled: true })).rejects.toThrow('stale recipient');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.createDelivery).not.toHaveBeenCalled();
  });
  it.each([
    [true, false, ['EMAIL']],
    [false, true, ['SMS']],
    [true, true, ['EMAIL', 'SMS']],
  ])('creates only explicitly selected channels (email=%s, sms=%s)', async (email, sms, expected) => {
    await updateDocumentReminderSchedule({
      ...base,
      recipientChannels: [{ id: 7, email: email as boolean, sms: sms as boolean }],
    });
    expect(mocks.createDelivery.mock.calls.map(([input]) => input.data.channel)).toEqual(expected);
    expect(mocks.metaUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    for (const [input] of mocks.createDelivery.mock.calls) {
      expect(input.data.smsEnabledOverride).toBe(input.data.channel === 'SMS' ? true : undefined);
    }
  });
  it('keeps email and SMS sequence identities separate', async () => {
    await updateDocumentReminderSchedule({
      ...base,
      total: 2,
      intervalDays: 3,
      recipientChannels: [{ id: 7, email: true, sms: true }],
    });
    const rows = mocks.createDelivery.mock.calls.map(([input]) => input.data);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.filter((row) => row.channel === 'EMAIL').map((row) => row.sequenceId)).size).toBe(1);
    expect(rows.find((row) => row.channel === 'EMAIL').sequenceId).not.toBe(
      rows.find((row) => row.channel === 'SMS').sequenceId,
    );
    expect(rows.every((row) => row.sequenceTotal === 2)).toBe(true);
  });
  it('rejects SMS when the team has disabled it before saving anything', async () => {
    mocks.smsContext.mockResolvedValue({ enabled: false });
    await expect(
      updateDocumentReminderSchedule({ ...base, recipientChannels: [{ id: 7, email: false, sms: true }] }),
    ).rejects.toThrow('unavailable');
    expect(mocks.updatePhones).not.toHaveBeenCalled();
    expect(mocks.createDelivery).not.toHaveBeenCalled();
  });
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])('preserves one signer push per scheduled occurrence for email=%s, SMS=%s', async (email, sms) => {
    await updateDocumentReminderSchedule({
      ...base,
      total: 2,
      intervalDays: 3,
      recipientChannels: [{ id: 7, email, sms }],
    });
    expect(mocks.enqueuePush).toHaveBeenCalledTimes(2);
    expect(mocks.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 7,
        audience: 'SIGNER',
        event: 'REMINDER',
        scheduledAt,
        occurrence: scheduledAt.toISOString(),
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('does not enqueue signer push if the schedule transaction fails', async () => {
    mocks.updatePhones.mockRejectedValueOnce(new Error('stale phone'));
    await expect(
      updateDocumentReminderSchedule({ ...base, recipientChannels: [{ id: 7, email: true, sms: false }] }),
    ).rejects.toThrow('stale phone');
    expect(mocks.enqueuePush).not.toHaveBeenCalled();
  });
});
