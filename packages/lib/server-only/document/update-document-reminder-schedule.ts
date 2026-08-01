import {
  getEarliestReminderAt,
  resolveNextReminderAt,
  ZEnvelopeReminderSettings,
} from '@documenso/lib/constants/envelope-reminder';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '@documenso/lib/types/document-email';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import {
  DocumentDistributionMethod,
  DocumentStatus,
  EnvelopeType,
  RecipientRole,
  ScheduledReminderDeliveryStatus,
  SigningStatus,
} from '@prisma/client';

import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertUserNotDisabled } from '../user/assert-user-not-disabled';

export type UpdateDocumentReminderScheduleOptions = {
  envelopeId: string;
  userId: number;
  teamId: number;
  recipients: number[];
  scheduledAt: Date | null;
};

export const updateDocumentReminderSchedule = async ({
  envelopeId,
  userId,
  teamId,
  recipients,
  scheduledAt,
}: UpdateDocumentReminderScheduleOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, disabled: true },
  });

  assertUserNotDisabled(user);

  if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Scheduled reminder time must be in the future',
      statusCode: 400,
    });
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: { type: 'envelopeId', id: envelopeId },
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findUnique({
    where: envelopeWhereInput,
    include: {
      documentMeta: true,
      recipients: {
        where: { id: { in: recipients } },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document could not be found',
    });
  }

  if (envelope.status !== DocumentStatus.PENDING || !envelope.documentMeta) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only pending documents can have reminders scheduled',
      statusCode: 400,
    });
  }

  if (
    envelope.documentMeta.distributionMethod === DocumentDistributionMethod.NONE ||
    !extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientSigningRequest
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Signing request emails are disabled for this document',
      statusCode: 400,
    });
  }

  const eligibleRecipients = envelope.recipients.filter(
    (recipient) => recipient.signingStatus === SigningStatus.NOT_SIGNED && recipient.role !== RecipientRole.CC,
  );

  if (eligibleRecipients.length !== recipients.length) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'One or more recipients cannot receive a reminder',
      statusCode: 400,
    });
  }

  const updatedAt = new Date();
  const reminderSettings = envelope.documentMeta.reminderSettings
    ? ZEnvelopeReminderSettings.parse(envelope.documentMeta.reminderSettings)
    : null;

  await prisma.$transaction(async (tx) => {
    for (const recipient of eligibleRecipients) {
      const automaticReminderAt = recipient.sentAt
        ? resolveNextReminderAt({
            config: reminderSettings,
            sentAt: recipient.sentAt,
            lastReminderSentAt: recipient.lastReminderSentAt,
            reminderCount: recipient.reminderCount,
          })
        : null;

      const activeDelivery = await tx.scheduledReminderDelivery.findFirst({
        where: {
          recipientId: recipient.id,
          status: {
            in: [ScheduledReminderDeliveryStatus.PENDING, ScheduledReminderDeliveryStatus.PROCESSING],
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (activeDelivery?.status === ScheduledReminderDeliveryStatus.PROCESSING) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'This reminder is already being delivered and can no longer be changed',
          statusCode: 409,
        });
      }

      if (activeDelivery) {
        await tx.scheduledReminderDelivery.update({
          where: { id: activeDelivery.id },
          data: {
            status: ScheduledReminderDeliveryStatus.CANCELLED,
            cancelledAt: updatedAt,
          },
        });

        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_CANCELLED,
            envelopeId: envelope.id,
            user,
            data: {
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              scheduledReminderId: activeDelivery.id,
              scheduledAt: activeDelivery.scheduledAt.toISOString(),
            },
          }),
        });
      }

      const delivery = scheduledAt
        ? await tx.scheduledReminderDelivery.create({
            data: {
              envelopeId: envelope.id,
              recipientId: recipient.id,
              createdById: userId,
              scheduledAt,
              nextAttemptAt: scheduledAt,
            },
          })
        : null;

      await tx.recipient.update({
        where: { id: recipient.id },
        data: scheduledAt
          ? {
              scheduledReminderAt: scheduledAt,
              scheduledReminderCreatedAt: updatedAt,
              scheduledReminderCreatedBy: userId,
              nextReminderAt: getEarliestReminderAt(automaticReminderAt, scheduledAt),
            }
          : {
              scheduledReminderAt: null,
              scheduledReminderCreatedAt: null,
              scheduledReminderCreatedBy: null,
              nextReminderAt: automaticReminderAt,
            },
      });

      if (delivery) {
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_SCHEDULED,
            envelopeId: envelope.id,
            user,
            data: {
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientId: recipient.id,
              recipientRole: recipient.role,
              scheduledReminderId: delivery.id,
              scheduledAt: delivery.scheduledAt.toISOString(),
            },
          }),
        });
      }
    }
  });

  return await prisma.recipient.findMany({
    where: { id: { in: recipients } },
    select: {
      id: true,
      scheduledReminderAt: true,
      scheduledReminderCreatedAt: true,
      scheduledReminderCreatedBy: true,
    },
  });
};
