import {
  getEarliestReminderAt,
  resolveNextReminderAt,
  ZEnvelopeReminderSettings,
} from '@documenso/lib/constants/envelope-reminder';
import { getScheduledReminderSequenceDates } from '@documenso/lib/constants/scheduled-reminder-delivery';
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
import { nanoid } from 'nanoid';
import type { TReminderRecipientPhone } from '../../types/recipient-phone';
import type { TReminderRecipientChannels } from '../../types/reminder-recipient-channels';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { enqueueDocumentNotification } from '../notifications/document-notifications';
import { updateReminderRecipientPhones } from '../recipient/update-reminder-recipient-phones';
import { validateReminderRecipientChannels } from '../recipient/validate-reminder-recipient-channels';
import { enqueueSmsDelivery } from '../sms/enqueue-sms-delivery';
import { getEnvelopeSmsContext } from '../sms/get-envelope-sms-context';
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
  recipientPhones?: TReminderRecipientPhone[];
  recipientChannels?: TReminderRecipientChannels;
  smsEnabled?: boolean;
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
  recipientPhones,
  recipientChannels,
  smsEnabled,
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
    scheduledAt &&
    (!recipientChannels || recipientChannels.some((recipient) => recipient.email)) &&
    (envelope.documentMeta.distributionMethod === DocumentDistributionMethod.NONE ||
      !extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientSigningRequest)
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

  const channels =
    scheduledAt && recipientChannels
      ? validateReminderRecipientChannels({
          recipientIds: recipients,
          eligibleRecipients,
          recipientChannels,
          recipientPhones,
        })
      : null;
  if (
    channels &&
    [...channels.values()].some((recipient) => recipient.sms) &&
    !(await getEnvelopeSmsContext({ teamId, documentSmsEnabled: true })).enabled
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Text messages are unavailable for this team.' });
  }

  const updatedAt = new Date();
  const reminderSettings = envelope.documentMeta.reminderSettings
    ? ZEnvelopeReminderSettings.parse(envelope.documentMeta.reminderSettings)
    : null;

  await prisma.$transaction(async (tx) => {
    if (scheduledAt) {
      await updateReminderRecipientPhones({
        tx,
        envelopeId: envelope.id,
        eligibleRecipientIds: eligibleRecipients.map((recipient) => recipient.id),
        recipientPhones,
      });

      if (!channels && smsEnabled !== undefined) {
        await tx.documentMeta.update({
          where: { id: envelope.documentMeta.id },
          data: { smsEnabled },
        });
      }
    }

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
          kind: 'REMINDER',
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

      const selectedChannels = channels?.get(recipient.id);
      const deliveryChannels = selectedChannels
        ? [...(selectedChannels.email ? ['EMAIL' as const] : []), ...(selectedChannels.sms ? ['SMS' as const] : [])]
        : ['EMAIL' as const];
      // Each channel owns its sequence, so an SMS failure cannot cancel email.
      const deliveries = scheduledAt
        ? (
            await Promise.all(
              deliveryChannels.map(async (channel) => {
                const sequenceId = nanoid(24);
                return await Promise.all(
                  sequenceDates.map((deliveryAt, index) =>
                    tx.scheduledReminderDelivery.create({
                      data: {
                        envelopeId: envelope.id,
                        recipientId: recipient.id,
                        createdById: userId,
                        channel,
                        ...(channel === 'SMS' ? { smsEnabledOverride: true } : {}),
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
                );
              }),
            )
          ).flat()
        : [];

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

      for (const delivery of deliveries.filter((_, index) => index % sequenceDates.length === 0)) {
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
              sequenceTotal: sequenceDates.length,
              ...(channels ? { channel: delivery.channel } : {}),
              timezone,
            },
          }),
        });
      }
    }
  });

  // Enqueued after the transaction commits, not inside it. enqueueSmsDelivery
  // uses the global client, so a rollback would otherwise leave a text queued
  // for a reminder that no longer exists.
  if (scheduledAt && channels) {
    await Promise.all(
      sequenceDates.flatMap((deliveryAt) =>
        recipients.map((recipientId) =>
          enqueueDocumentNotification({
            envelopeId: envelope.id,
            teamId,
            recipientId,
            audience: 'SIGNER',
            event: 'REMINDER',
            scheduledAt: deliveryAt,
            occurrence: deliveryAt.toISOString(),
          }).catch(() => {
            console.error('Could not queue signer push notification');
          }),
        ),
      ),
    );
  }
  if (scheduledAt && !channels) {
    await Promise.all(
      sequenceDates.flatMap((deliveryAt) =>
        recipients.map((recipientId) =>
          enqueueSmsDelivery({
            envelopeId: envelope.id,
            recipientId,
            teamId,
            documentSmsEnabled: smsEnabled ?? envelope.documentMeta?.smsEnabled ?? null,
            kind: 'REMINDER',
            createdById: userId,
            scheduledAt: deliveryAt,
          }).catch((error) => {
            console.error('Could not queue a reminder SMS', error);
          }),
        ),
      ),
    );
  }

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
