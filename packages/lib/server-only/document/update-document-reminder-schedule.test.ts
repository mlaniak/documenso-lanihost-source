import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
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
    mocks.envelope.mockResolvedValue({
      id: 'env-1',
      status: 'PENDING',
      documentMeta: { id: 'meta-1', distributionMethod: 'EMAIL', smsEnabled: false, reminderSettings: null },
      recipients: [
        {
          id: 7,
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
});
