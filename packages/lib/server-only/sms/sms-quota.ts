import { prisma } from '@documenso/prisma';

/**
 * Four triggers can each produce a text, and each one retries. A per-recipient
 * daily cap keeps a scheduling bug or a retry loop from turning into a carrier
 * complaint, which is the kind of thing that puts an A2P registration at risk.
 */
export const MAX_SMS_PER_RECIPIENT_PER_DAY = 4;

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

export const isRecipientSmsQuotaExceeded = async (options: { recipientId: number; now?: Date }): Promise<boolean> => {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - ONE_DAY_IN_MS);

  // Counting only SENT rows lets a burst blow past the cap before any of them
  // settle, so due-but-unsent rows count too. Rows scheduled for the future are
  // deliberately excluded: a reminder set for next week is not today's traffic.
  const usedInLastDay = await prisma.scheduledReminderDelivery.count({
    where: {
      recipientId: options.recipientId,
      channel: 'SMS',
      OR: [
        { status: 'SENT', sentAt: { gte: cutoff } },
        {
          status: { in: ['PENDING', 'PROCESSING'] },
          scheduledAt: { gte: cutoff, lte: now },
        },
      ],
    },
  });

  return usedInLastDay >= MAX_SMS_PER_RECIPIENT_PER_DAY;
};
