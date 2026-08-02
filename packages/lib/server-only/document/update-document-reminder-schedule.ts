import {
  getEarliestReminderAt,
  resolveNextReminderAt,
  ZEnvelopeReminderSettings,
} from '@documenso/lib/constants/envelope-reminder';
import { getScheduledReminderSequenceDates } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '@documenso/lib/types/document-email';
import { normalizeReminderToBusinessWindow, parseTeamOperationsSettings } from '@documenso/lib/types/team-operations';
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
import { nanoid } from 'nanoid';

import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertUserNotDisabled } from '../user/assert-user-not-disabled';

export type UpdateDocumentReminderScheduleOptions = {
  envelopeId: string;
  userId: number;
  teamId: number;
  recipients: number[];
  scheduledAt: Date | null;
  timezone?: string;
  total?: number;
  intervalDays?: number | null;
};

export const updateDocumentReminderSchedule = async ({
  envelopeId,
  userId,
  teamId,
  recipients,
  scheduledAt,
  timezone = 'Etc/UTC',
  total = 1,
  intervalDays = null,
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

  let sequenceDates: Date[] = [];

  if (scheduledAt) {
    try {
      sequenceDates = getScheduledReminderSequenceDates({ scheduledAt, timezone, total, intervalDays });
    } catch (error) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: error instanceof Error ? error.message : 'Reminder sequence is invalid',
        statusCode: 400,
      });
    }
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
      team: {
        select: {
          teamGlobalSettings: {
            select: { operationsSettings: true },
          },
        },
      },
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

  const operationsSettings = parseTeamOperationsSettings(envelope.team.teamGlobalSettings.operationsSettings);

  sequenceDates = sequenceDates.reduce<Date[]>((dates, date) => {
    let normalized = normalizeReminderToBusinessWindow({ date, timezone, settings: operationsSettings });
    const previous = dates.at(-1);

    if (previous && normalized.getTime() <= previous.getTime()) {
      normalized = normalizeReminderToBusinessWindow({
        date: new Date(previous.getTime() + 24 * 60 * 60 * 1000),
        timezone,
        settings: operationsSettings,
      });
    }

    dates.push(normalized);

    return dates;
  }, []);

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

      const activeDeliveries = await tx.scheduledReminderDelivery.findMany({
        where: {
          recipientId: recipient.id,
          status: {
            in: [ScheduledReminderDeliveryStatus.PENDING, ScheduledReminderDeliveryStatus.PROCESSING],
          },
        },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      });

      if (activeDeliveries.some((delivery) => delivery.status === ScheduledReminderDeliveryStatus.PROCESSING)) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'This reminder is already being delivered and can no longer be changed',
          statusCode: 409,
        });
      }

      if (activeDeliveries.length > 0) {
        await tx.scheduledReminderDelivery.updateMany({
          where: { id: { in: activeDeliveries.map((delivery) => delivery.id) } },
          data: {
            status: ScheduledReminderDeliveryStatus.CANCELLED,
            cancelledAt: updatedAt,
            lastErrorCode: 'SCHEDULE_REPLACED',
            lastErrorMessage: 'The reminder schedule was replaced or cancelled',
          },
        });

        const activeDelivery = activeDeliveries[0];

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

      const sequenceId = scheduledAt ? nanoid(24) : null;
      const deliveries = scheduledAt
        ? await Promise.all(
            sequenceDates.map((deliveryAt, index) =>
              tx.scheduledReminderDelivery.create({
                data: {
                  envelopeId: envelope.id,
                  recipientId: recipient.id,
                  createdById: userId,
                  scheduledAt: deliveryAt,
                  nextAttemptAt: deliveryAt,
                  sequenceId,
                  sequencePosition: index + 1,
                  sequenceTotal: sequenceDates.length,
                  sequenceIntervalDays: sequenceDates.length > 1 ? intervalDays : null,
                  timezone,
                },
              }),
            ),
          )
        : [];
      const delivery = deliveries[0] ?? null;

      await tx.recipient.update({
        where: { id: recipient.id },
        data: scheduledAt
          ? {
              scheduledReminderAt: sequenceDates[0],
              scheduledReminderCreatedAt: updatedAt,
              scheduledReminderCreatedBy: userId,
              nextReminderAt: getEarliestReminderAt(automaticReminderAt, sequenceDates[0]),
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
              sequenceTotal: deliveries.length,
              timezone,
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
