import {
  getScheduledReminderErrorDetails,
  getScheduledReminderIdempotencyKey,
  getScheduledReminderMessageId,
  getScheduledReminderRetryAt,
  isScheduledReminderErrorRetryable,
  MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS,
} from '@documenso/lib/constants/scheduled-reminder-delivery';
import { prisma } from '@documenso/prisma';
import type { Envelope, Recipient, ScheduledReminderDelivery, User } from '@prisma/client';
import {
  DocumentStatus,
  RecipientRole,
  ScheduledReminderDeliveryStatus,
  ScheduledReminderProviderStatus,
  SigningStatus,
} from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { resendDocument } from '../../../server-only/document/resend-document';
import { updateRecipientNextReminder } from '../../../server-only/recipient/update-recipient-next-reminder';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import type { JobRunIO } from '../../client/_internal/job';

export const processScheduledReminderDelivery = async (options: { deliveryId: string; io: JobRunIO }) => {
  const { deliveryId, io } = options;
  const now = new Date();

  const claim = await prisma.scheduledReminderDelivery.updateMany({
    where: {
      id: deliveryId,
      status: ScheduledReminderDeliveryStatus.PENDING,
      nextAttemptAt: { lte: now },
    },
    data: {
      status: ScheduledReminderDeliveryStatus.PROCESSING,
      claimedAt: now,
      attemptCount: { increment: 1 },
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  if (claim.count === 0) {
    io.logger.info(`Scheduled reminder delivery ${deliveryId} was already claimed or is not due`);
    return;
  }

  const delivery = await prisma.scheduledReminderDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: {
      createdBy: {
        select: { id: true, email: true, name: true, disabled: true },
      },
      recipient: true,
      envelope: {
        include: {
          user: {
            select: { id: true, email: true, name: true, disabled: true },
          },
        },
      },
    },
  });

  const isEligible =
    delivery.envelope.status === DocumentStatus.PENDING &&
    delivery.envelope.deletedAt === null &&
    delivery.recipient.signingStatus === SigningStatus.NOT_SIGNED &&
    delivery.recipient.role !== RecipientRole.CC &&
    (!delivery.recipient.expiresAt || delivery.recipient.expiresAt > now);

  if (!isEligible) {
    await cancelIneligibleDelivery(delivery);
    io.logger.info(`Scheduled reminder delivery ${deliveryId} is no longer eligible and was cancelled`);
    return;
  }

  const deliveryUser = !delivery.createdBy?.disabled
    ? delivery.createdBy
    : !delivery.envelope.user.disabled
      ? delivery.envelope.user
      : null;

  if (!deliveryUser) {
    await recordDeliveryFailure({
      delivery,
      error: new Error('The scheduler and document owner are unavailable or disabled'),
      isTerminal: true,
    });
    io.logger.error(`Scheduled reminder delivery ${deliveryId} has no active sender`);
    return;
  }

  const providerMessageId = getScheduledReminderMessageId(delivery.id, NEXT_PUBLIC_WEBAPP_URL());

  await prisma.scheduledReminderDelivery.update({
    where: { id: delivery.id },
    data: { providerMessageId },
  });

  const deliveryState = await prisma.scheduledReminderDelivery.findUnique({
    where: { id: delivery.id },
    select: { status: true },
  });

  if (deliveryState?.status !== ScheduledReminderDeliveryStatus.PROCESSING) {
    io.logger.info(`Scheduled reminder delivery ${deliveryId} was cancelled before provider submission`);
    return;
  }

  try {
    await resendDocument({
      id: { type: 'envelopeId', id: delivery.envelopeId },
      userId: deliveryUser.id,
      teamId: delivery.envelope.teamId,
      recipients: [delivery.recipientId],
      requireEmailDelivery: true,
      emailDeliveryTracking: {
        messageId: providerMessageId,
        idempotencyKey: getScheduledReminderIdempotencyKey(delivery.id),
      },
      requestMetadata: {
        source: 'app',
        auth: 'session',
        requestMetadata: { userAgent: 'Documenso scheduled reminder delivery' },
        auditUser: deliveryUser,
      },
    });

    const sentAt = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.scheduledReminderDelivery.update({
        where: {
          id: delivery.id,
          status: ScheduledReminderDeliveryStatus.PROCESSING,
        },
        data: {
          status: ScheduledReminderDeliveryStatus.SENT,
          sentAt,
          claimedAt: null,
        },
      });

      await tx.scheduledReminderDelivery.updateMany({
        where: {
          id: delivery.id,
          providerStatus: null,
        },
        data: {
          providerStatus: ScheduledReminderProviderStatus.SUBMITTED,
          providerStatusAt: sentAt,
          providerSubmittedAt: sentAt,
        },
      });

      const nextDelivery = await tx.scheduledReminderDelivery.findFirst({
        where: {
          recipientId: delivery.recipientId,
          status: ScheduledReminderDeliveryStatus.PENDING,
          scheduledAt: { gt: delivery.scheduledAt },
          ...(delivery.sequenceId ? { sequenceId: delivery.sequenceId } : {}),
        },
        orderBy: { scheduledAt: 'asc' },
      });

      await tx.recipient.updateMany({
        where: {
          id: delivery.recipientId,
          scheduledReminderAt: delivery.scheduledAt,
        },
        data: {
          scheduledReminderAt: nextDelivery?.scheduledAt ?? null,
          scheduledReminderCreatedAt: nextDelivery ? nextDelivery.createdAt : null,
          scheduledReminderCreatedBy: nextDelivery ? nextDelivery.createdById : null,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_SENT,
          envelopeId: delivery.envelopeId,
          user: deliveryUser,
          requestMetadata: { userAgent: 'Documenso scheduled reminder delivery' },
          data: {
            ...getAuditData(delivery),
            attemptCount: delivery.attemptCount,
          },
        }),
      });
    });

    await updateRecipientNextReminder({
      recipientId: delivery.recipientId,
      envelopeId: delivery.envelopeId,
      sentAt,
      lastReminderSentAt: null,
      resetReminderCount: true,
    }).catch((error) => {
      io.logger.warn(`Could not recompute automatic reminders after delivery ${delivery.id}`, error);
    });

    io.logger.info(`Scheduled reminder delivery ${deliveryId} sent on attempt ${delivery.attemptCount}`);
  } catch (error) {
    const currentDelivery = await prisma.scheduledReminderDelivery.findUnique({
      where: { id: delivery.id },
      select: { status: true },
    });

    if (currentDelivery?.status === ScheduledReminderDeliveryStatus.CANCELLED) {
      io.logger.warn(`Scheduled reminder delivery ${deliveryId} was cancelled while processing`);
      return;
    }

    const isRetryable = isScheduledReminderErrorRetryable(error);
    const isTerminal = !isRetryable || delivery.attemptCount >= MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS;

    await recordDeliveryFailure({ delivery, error, isTerminal, isRetryable });

    const details = getScheduledReminderErrorDetails(error);
    io.logger.error({
      msg: isTerminal ? 'Scheduled reminder delivery failed permanently' : 'Scheduled reminder delivery will retry',
      deliveryId,
      recipientId: delivery.recipientId,
      attemptCount: delivery.attemptCount,
      errorCode: details.code,
    });
  }
};

const cancelIneligibleDelivery = async (delivery: ScheduledReminderDeliveryContext) => {
  const cancelledAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.scheduledReminderDelivery.updateMany({
      where: delivery.sequenceId
        ? {
            sequenceId: delivery.sequenceId,
            status: {
              in: [ScheduledReminderDeliveryStatus.PENDING, ScheduledReminderDeliveryStatus.PROCESSING],
            },
          }
        : { id: delivery.id },
      data: {
        status: ScheduledReminderDeliveryStatus.CANCELLED,
        cancelledAt,
        claimedAt: null,
        lastErrorCode: 'RECIPIENT_NO_LONGER_ELIGIBLE',
        lastErrorMessage: 'The document or recipient no longer accepts reminders',
      },
    });

    await tx.recipient.updateMany({
      where: { id: delivery.recipientId, scheduledReminderAt: delivery.scheduledAt },
      data: {
        scheduledReminderAt: null,
        scheduledReminderCreatedAt: null,
        scheduledReminderCreatedBy: null,
        nextReminderAt: null,
      },
    });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_CANCELLED,
        envelopeId: delivery.envelopeId,
        user: delivery.createdBy,
        requestMetadata: { userAgent: 'Documenso scheduled reminder delivery' },
        data: getAuditData(delivery),
      }),
    });
  });
};

const recordDeliveryFailure = async (options: {
  delivery: ScheduledReminderDeliveryContext;
  error: unknown;
  isTerminal: boolean;
  isRetryable?: boolean;
}) => {
  const { delivery, error, isTerminal, isRetryable = false } = options;
  const details = getScheduledReminderErrorDetails(error);
  const failedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.scheduledReminderDelivery.update({
      where: { id: delivery.id },
      data: isTerminal
        ? {
            status: ScheduledReminderDeliveryStatus.FAILED,
            failedAt,
            claimedAt: null,
            lastErrorCode: details.code,
            lastErrorMessage: details.message,
            retryable: isRetryable,
          }
        : {
            status: ScheduledReminderDeliveryStatus.PENDING,
            nextAttemptAt: getScheduledReminderRetryAt(delivery.attemptCount, failedAt),
            claimedAt: null,
            lastErrorCode: details.code,
            lastErrorMessage: details.message,
            retryable: true,
          },
    });

    if (isTerminal) {
      if (delivery.sequenceId) {
        await tx.scheduledReminderDelivery.updateMany({
          where: {
            sequenceId: delivery.sequenceId,
            id: { not: delivery.id },
            status: ScheduledReminderDeliveryStatus.PENDING,
          },
          data: {
            status: ScheduledReminderDeliveryStatus.CANCELLED,
            cancelledAt: failedAt,
            lastErrorCode: 'PREVIOUS_DELIVERY_FAILED',
            lastErrorMessage: 'The reminder sequence stopped after an earlier delivery failed',
          },
        });
      }

      await tx.recipient.updateMany({
        where: { id: delivery.recipientId, scheduledReminderAt: delivery.scheduledAt },
        data: {
          scheduledReminderAt: null,
          scheduledReminderCreatedAt: null,
          scheduledReminderCreatedBy: null,
          nextReminderAt: null,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_FAILED,
          envelopeId: delivery.envelopeId,
          user: delivery.createdBy,
          requestMetadata: { userAgent: 'Documenso scheduled reminder delivery' },
          data: {
            ...getAuditData(delivery),
            attemptCount: delivery.attemptCount,
            errorCode: details.code,
            errorMessage: details.message,
          },
        }),
      });
    }
  });

  if (isTerminal && delivery.recipient.sentAt) {
    await updateRecipientNextReminder({
      recipientId: delivery.recipientId,
      envelopeId: delivery.envelopeId,
      sentAt: delivery.recipient.sentAt,
      lastReminderSentAt: delivery.recipient.lastReminderSentAt,
      reminderCount: delivery.recipient.reminderCount,
    });
  }
};

type ScheduledReminderDeliveryUser = Pick<User, 'id' | 'email' | 'name' | 'disabled'>;

type ScheduledReminderDeliveryContext = ScheduledReminderDelivery & {
  createdBy: ScheduledReminderDeliveryUser | null;
  recipient: Recipient;
  envelope: Envelope & { user: ScheduledReminderDeliveryUser };
};

const getAuditData = (delivery: ScheduledReminderDeliveryContext) => ({
  recipientEmail: delivery.recipient.email,
  recipientName: delivery.recipient.name,
  recipientId: delivery.recipient.id,
  recipientRole: delivery.recipient.role,
  scheduledReminderId: delivery.id,
  scheduledAt: delivery.scheduledAt.toISOString(),
});
