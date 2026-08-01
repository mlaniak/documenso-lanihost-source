import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  RecipientRole,
  ScheduledReminderDeliveryStatus,
  SendStatus,
  SigningStatus,
} from '@prisma/client';

import { SCHEDULED_REMINDER_CLAIM_TIMEOUT_MINUTES } from '../../../constants/scheduled-reminder-delivery';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendSigningRemindersSweepJobDefinition } from './send-signing-reminders-sweep';

export const run = async ({ io }: { payload: TSendSigningRemindersSweepJobDefinition; io: JobRunIO }) => {
  const now = new Date();
  const staleClaimedAt = new Date(now.getTime() - SCHEDULED_REMINDER_CLAIM_TIMEOUT_MINUTES * 60_000);

  const recoveredClaims = await prisma.scheduledReminderDelivery.updateMany({
    where: {
      status: ScheduledReminderDeliveryStatus.PROCESSING,
      claimedAt: { lt: staleClaimedAt },
    },
    data: {
      status: ScheduledReminderDeliveryStatus.PENDING,
      claimedAt: null,
      nextAttemptAt: now,
      lastErrorCode: 'STALE_CLAIM_RECOVERED',
      lastErrorMessage: 'The previous worker claim expired before delivery completed',
    },
  });

  if (recoveredClaims.count > 0) {
    io.logger.warn(`Recovered ${recoveredClaims.count} stale scheduled reminder delivery claim(s)`);
  }

  const scheduledDeliveries = await prisma.scheduledReminderDelivery.findMany({
    where: {
      status: ScheduledReminderDeliveryStatus.PENDING,
      nextAttemptAt: { lte: now },
    },
    select: { id: true, recipientId: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: 1000,
  });

  const recipients = await prisma.recipient.findMany({
    where: {
      nextReminderAt: { lte: now },
      signingStatus: SigningStatus.NOT_SIGNED,
      role: { not: RecipientRole.CC },
      sendStatus: SendStatus.SENT,
      // Skip automatic reminders whose signing deadline has passed or whose
      // one-off scheduled delivery is already due/retrying.
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ scheduledReminderAt: null }, { scheduledReminderAt: { gt: now } }] },
      ],
      envelope: {
        status: DocumentStatus.PENDING,
        deletedAt: null,
      },
    },
    select: { id: true },
    take: 1000,
  });

  if (recipients.length === 0 && scheduledDeliveries.length === 0) {
    io.logger.info('No recipients need signing reminders');
    return;
  }

  io.logger.info(
    `Found ${scheduledDeliveries.length} scheduled deliveries and ${recipients.length} automatic reminders`,
  );

  await Promise.allSettled(
    scheduledDeliveries.map(async (delivery) => {
      await jobs.triggerJob({
        name: 'internal.process-signing-reminder',
        payload: {
          recipientId: delivery.recipientId,
          scheduledReminderDeliveryId: delivery.id,
        },
      });
    }),
  );

  await Promise.allSettled(
    recipients.map(async (recipient) => {
      await jobs.triggerJob({
        name: 'internal.process-signing-reminder',
        payload: {
          recipientId: recipient.id,
        },
      });
    }),
  );
};
