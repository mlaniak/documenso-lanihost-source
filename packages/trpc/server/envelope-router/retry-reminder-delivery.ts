import { MAX_SCHEDULED_REMINDER_MANUAL_RETRIES } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, ScheduledReminderDeliveryStatus, SigningStatus } from '@prisma/client';
import { z } from 'zod';

import { ZSuccessResponseSchema } from '../schema';
import { authenticatedProcedure } from '../trpc';
import { assertReminderManager } from './find-reminder-schedules';

export const retryReminderDeliveryRoute = authenticatedProcedure
  .input(z.object({ deliveryId: z.string() }))
  .output(ZSuccessResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertReminderManager(ctx.teamId, ctx.user.id);

    const delivery = await prisma.scheduledReminderDelivery.findFirst({
      where: { id: input.deliveryId, envelope: { teamId: ctx.teamId } },
      include: { envelope: true, recipient: true },
    });

    const isEligible =
      delivery?.status === ScheduledReminderDeliveryStatus.FAILED &&
      delivery.retryable &&
      delivery.manualRetryCount < MAX_SCHEDULED_REMINDER_MANUAL_RETRIES &&
      delivery.envelope.status === DocumentStatus.PENDING &&
      delivery.envelope.deletedAt === null &&
      delivery.recipient.signingStatus === SigningStatus.NOT_SIGNED &&
      (!delivery.recipient.expiresAt || delivery.recipient.expiresAt > new Date());

    if (!delivery || !isEligible) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'This delivery cannot be retried safely',
        statusCode: 409,
      });
    }

    const retryAt = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.scheduledReminderDelivery.update({
        where: { id: delivery.id },
        data: {
          status: ScheduledReminderDeliveryStatus.PENDING,
          nextAttemptAt: retryAt,
          scheduledAt: retryAt,
          attemptCount: 0,
          manualRetryCount: { increment: 1 },
          failedAt: null,
          claimedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      await tx.recipient.update({
        where: { id: delivery.recipientId },
        data: {
          scheduledReminderAt: retryAt,
          scheduledReminderCreatedAt: retryAt,
          scheduledReminderCreatedBy: ctx.user.id,
          nextReminderAt: retryAt,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_SCHEDULED,
          envelopeId: delivery.envelopeId,
          user: ctx.user,
          data: {
            recipientEmail: delivery.recipient.email,
            recipientName: delivery.recipient.name,
            recipientId: delivery.recipient.id,
            recipientRole: delivery.recipient.role,
            scheduledReminderId: delivery.id,
            scheduledAt: retryAt.toISOString(),
            retryRequested: true,
          },
        }),
      });
    });

    return { success: true };
  });
