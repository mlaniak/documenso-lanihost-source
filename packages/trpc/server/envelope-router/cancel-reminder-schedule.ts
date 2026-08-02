import {
  getEarliestReminderAt,
  resolveNextReminderAt,
  ZEnvelopeReminderSettings,
} from '@documenso/lib/constants/envelope-reminder';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { ScheduledReminderDeliveryStatus } from '@prisma/client';
import { z } from 'zod';

import { ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure } from '../trpc';
import { assertReminderManager } from './find-reminder-schedules';

export const cancelReminderScheduleRoute = authenticatedProcedure
  .input(z.object({ sequenceId: z.string().nullable(), primaryDeliveryId: z.string() }))
  .output(ZSuccessResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertReminderManager(ctx.teamId, ctx.user.id);

    const active = await prisma.scheduledReminderDelivery.findMany({
      where: {
        ...(input.sequenceId ? { sequenceId: input.sequenceId } : { id: input.primaryDeliveryId }),
        envelope: { teamId: ctx.teamId },
        status: { in: [ScheduledReminderDeliveryStatus.PENDING, ScheduledReminderDeliveryStatus.PROCESSING] },
      },
      include: { recipient: true, envelope: { include: { documentMeta: true } } },
    });

    if (active.length === 0) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Active reminder schedule not found' });
    }

    const cancelledAt = new Date();
    const recipient = active[0].recipient;
    const envelope = active[0].envelope;
    const reminderSettings = envelope.documentMeta.reminderSettings
      ? ZEnvelopeReminderSettings.parse(envelope.documentMeta.reminderSettings)
      : null;
    const automaticReminderAt = recipient.sentAt
      ? resolveNextReminderAt({
          config: reminderSettings,
          sentAt: recipient.sentAt,
          lastReminderSentAt: recipient.lastReminderSentAt,
          reminderCount: recipient.reminderCount,
        })
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.scheduledReminderDelivery.updateMany({
        where: { id: { in: active.map((delivery) => delivery.id) } },
        data: {
          status: ScheduledReminderDeliveryStatus.CANCELLED,
          cancelledAt,
          claimedAt: null,
          lastErrorCode: 'MANUALLY_CANCELLED',
          lastErrorMessage: 'The reminder schedule was cancelled by a team manager',
        },
      });

      await tx.recipient.update({
        where: { id: recipient.id },
        data: {
          scheduledReminderAt: null,
          scheduledReminderCreatedAt: null,
          scheduledReminderCreatedBy: null,
          nextReminderAt: getEarliestReminderAt(automaticReminderAt, null),
        },
      });

      await tx.documentAuditLog.createMany({
        data: active.map((delivery) =>
          createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_CANCELLED,
            envelopeId: envelope.id,
            user: ctx.user,
            data: {
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              scheduledReminderId: delivery.id,
              scheduledAt: delivery.scheduledAt.toISOString(),
            },
          }),
        ),
      });
    });

    return { success: true };
  });
