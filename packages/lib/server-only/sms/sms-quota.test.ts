import { beforeEach, describe, expect, it, vi } from 'vitest';

const count = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    scheduledReminderDelivery: {
      count: (...args: unknown[]) => count(...args),
    },
  },
}));

const { MAX_SMS_PER_RECIPIENT_PER_DAY, isRecipientSmsQuotaExceeded } = await import('./sms-quota');

const now = new Date('2026-08-09T12:00:00.000Z');

describe('isRecipientSmsQuotaExceeded', () => {
  beforeEach(() => {
    count.mockReset();
  });

  it('allows a recipient under the daily cap', async () => {
    count.mockResolvedValue(MAX_SMS_PER_RECIPIENT_PER_DAY - 1);

    await expect(isRecipientSmsQuotaExceeded({ recipientId: 5, now })).resolves.toBe(false);
  });

  it('blocks a recipient at the daily cap', async () => {
    count.mockResolvedValue(MAX_SMS_PER_RECIPIENT_PER_DAY);

    await expect(isRecipientSmsQuotaExceeded({ recipientId: 5, now })).resolves.toBe(true);
  });

  it('counts sent and due-but-unsent sms deliveries, ignoring future ones', async () => {
    count.mockResolvedValue(0);

    await isRecipientSmsQuotaExceeded({ recipientId: 5, now });

    const cutoff = new Date('2026-08-08T12:00:00.000Z');

    expect(count).toHaveBeenCalledWith({
      where: {
        recipientId: 5,
        channel: 'SMS',
        OR: [
          { status: 'SENT', sentAt: { gte: cutoff } },
          { status: { in: ['PENDING', 'PROCESSING'] }, scheduledAt: { gte: cutoff, lte: now } },
        ],
      },
    });
  });
});
