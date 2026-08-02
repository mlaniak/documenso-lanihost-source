import { verifyResendWebhook } from '@documenso/email/providers/resend-webhook';
import { normaliseEmailMessageId } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';
import { ScheduledReminderDeliveryStatus, ScheduledReminderProviderStatus } from '@prisma/client';
import { z } from 'zod';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { env } from '../../utils/env';
import { logger } from '../../utils/logger';
import { updateRecipientNextReminder } from '../recipient/update-recipient-next-reminder';

const MAX_RESEND_WEBHOOK_BYTES = 64 * 1024;

export const ZResendDeliveryEventSchema = z
  .object({
    type: z.enum([
      'email.sent',
      'email.delivered',
      'email.delivery_delayed',
      'email.bounced',
      'email.failed',
      'email.suppressed',
    ]),
    created_at: z.string().datetime(),
    data: z
      .object({
        email_id: z.string().min(1).max(255),
        message_id: z.string().min(3).max(512),
        bounce: z
          .object({
            type: z.string().max(100).optional(),
            subType: z.string().max(100).optional(),
          })
          .optional(),
        failed: z
          .object({
            reason: z.string().max(100).optional(),
          })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ResendDeliveryEvent = z.infer<typeof ZResendDeliveryEventSchema>;

export const handleResendDeliveryWebhook = async (request: Request): Promise<Response> => {
  const webhookSecret = env('NEXT_PRIVATE_RESEND_WEBHOOK_SECRET');

  if (!webhookSecret) {
    logger.error({ msg: 'Resend delivery webhook secret is not configured' });
    return new Response('Webhook unavailable', { status: 503 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');

  if (Number.isFinite(contentLength) && contentLength > MAX_RESEND_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const webhookId = request.headers.get('svix-id');
  const webhookTimestamp = request.headers.get('svix-timestamp');
  const webhookSignature = request.headers.get('svix-signature');

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return new Response('Missing webhook signature', { status: 400 });
  }

  const payload = await request.text();

  if (Buffer.byteLength(payload, 'utf8') > MAX_RESEND_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  let verifiedPayload: unknown;

  try {
    verifiedPayload = verifyResendWebhook({
      payload,
      webhookId,
      webhookTimestamp,
      webhookSignature,
      webhookSecret,
    });
  } catch {
    return new Response('Invalid webhook signature', { status: 400 });
  }

  const parsedEvent = ZResendDeliveryEventSchema.safeParse(verifiedPayload);

  if (!parsedEvent.success) {
    logger.warn({
      msg: 'Ignoring an unsupported or malformed signed Resend delivery event',
      webhookId,
    });
    return Response.json({ received: true, processed: false });
  }

  const wasProcessed = await processResendDeliveryEvent(webhookId, parsedEvent.data);

  return Response.json({ received: true, processed: wasProcessed });
};

export const processResendDeliveryEvent = async (webhookId: string, event: ResendDeliveryEvent): Promise<boolean> => {
  const messageId = normaliseEmailMessageId(event.data.message_id);
  const occurredAt = new Date(event.created_at);
  const mapping = mapResendDeliveryEvent(event);

  const delivery = await prisma.scheduledReminderDelivery.findUnique({
    where: { providerMessageId: messageId },
    select: {
      id: true,
      envelopeId: true,
      scheduledAt: true,
      sequenceId: true,
      createdBy: { select: { id: true, email: true, name: true } },
      recipient: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          sentAt: true,
          lastReminderSentAt: true,
          reminderCount: true,
        },
      },
    },
  });

  if (!delivery) {
    logger.info({
      msg: 'Signed Resend event did not match a scheduled reminder',
      webhookId,
      eventType: event.type,
    });
    return false;
  }

  const stopSequence =
    delivery.sequenceId !== null && ['email.bounced', 'email.failed', 'email.suppressed'].includes(event.type);

  const result = await prisma.$transaction(async (tx) => {
    const insertedEvent = await tx.scheduledReminderProviderEvent.createMany({
      data: [
        {
          id: webhookId,
          eventType: event.type,
          occurredAt,
          providerEmailId: event.data.email_id,
          messageId,
          deliveryId: delivery.id,
        },
      ],
      skipDuplicates: true,
    });

    if (insertedEvent.count === 0) {
      return { processed: false, stoppedSequence: false };
    }

    await tx.scheduledReminderDelivery.updateMany({
      where: { id: delivery.id, providerEmailId: null },
      data: { providerEmailId: event.data.email_id },
    });

    const updatedDelivery = await tx.scheduledReminderDelivery.updateMany({
      where: {
        id: delivery.id,
        AND: [
          {
            OR: [{ providerStatus: null }, { providerStatus: { notIn: mapping.blockedStatuses } }],
          },
          {
            OR: [{ providerStatusAt: null }, { providerStatusAt: { lt: occurredAt } }],
          },
        ],
      },
      data: mapping.update,
    });

    if (updatedDelivery.count === 1 && mapping.auditType) {
      await tx.documentAuditLog.create({
        data: createProviderAuditLogData({
          auditType: mapping.auditType,
          delivery,
          occurredAt,
          providerFailureCode: mapping.providerFailureCode,
        }),
      });
    }

    if (updatedDelivery.count === 1 && stopSequence && delivery.sequenceId) {
      await tx.scheduledReminderDelivery.updateMany({
        where: {
          sequenceId: delivery.sequenceId,
          status: ScheduledReminderDeliveryStatus.PENDING,
        },
        data: {
          status: ScheduledReminderDeliveryStatus.CANCELLED,
          cancelledAt: occurredAt,
          lastErrorCode: 'PERMANENT_PROVIDER_FAILURE',
          lastErrorMessage: 'The reminder sequence stopped after a permanent email delivery failure',
          retryable: false,
        },
      });

      await tx.recipient.update({
        where: { id: delivery.recipient.id },
        data: {
          scheduledReminderAt: null,
          scheduledReminderCreatedAt: null,
          scheduledReminderCreatedBy: null,
        },
      });
    }

    return { processed: true, stoppedSequence: updatedDelivery.count === 1 && stopSequence };
  });

  if (result.stoppedSequence && delivery.recipient.sentAt) {
    await updateRecipientNextReminder({
      recipientId: delivery.recipient.id,
      envelopeId: delivery.envelopeId,
      sentAt: delivery.recipient.sentAt,
      lastReminderSentAt: delivery.recipient.lastReminderSentAt,
      reminderCount: delivery.recipient.reminderCount,
    });
  }

  return result.processed;
};

export const mapResendDeliveryEvent = (event: ResendDeliveryEvent) => {
  const baseUpdate = {
    providerStatusAt: new Date(event.created_at),
    providerEmailId: event.data.email_id,
  };

  switch (event.type) {
    case 'email.sent':
      return {
        auditType: null,
        blockedStatuses: [
          ScheduledReminderProviderStatus.DELAYED,
          ScheduledReminderProviderStatus.DELIVERED,
          ScheduledReminderProviderStatus.BOUNCED,
          ScheduledReminderProviderStatus.FAILED,
          ScheduledReminderProviderStatus.SUPPRESSED,
        ],
        providerFailureCode: null,
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.SUBMITTED,
          providerSubmittedAt: new Date(event.created_at),
          providerFailureCode: null,
        },
      } satisfies ProviderEventMapping;
    case 'email.delivered':
      return {
        auditType: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERED,
        blockedStatuses: [
          ScheduledReminderProviderStatus.BOUNCED,
          ScheduledReminderProviderStatus.FAILED,
          ScheduledReminderProviderStatus.SUPPRESSED,
        ],
        providerFailureCode: null,
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.DELIVERED,
          providerDeliveredAt: new Date(event.created_at),
          providerFailureCode: null,
        },
      } satisfies ProviderEventMapping;
    case 'email.delivery_delayed':
      return {
        auditType: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_DELAYED,
        blockedStatuses: [
          ScheduledReminderProviderStatus.DELIVERED,
          ScheduledReminderProviderStatus.BOUNCED,
          ScheduledReminderProviderStatus.FAILED,
          ScheduledReminderProviderStatus.SUPPRESSED,
        ],
        providerFailureCode: null,
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.DELAYED,
          providerDelayedAt: new Date(event.created_at),
          providerFailureCode: null,
        },
      } satisfies ProviderEventMapping;
    case 'email.bounced': {
      const providerFailureCode = [event.data.bounce?.type, event.data.bounce?.subType]
        .filter(Boolean)
        .join(':')
        .slice(0, 200);

      return {
        auditType: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_BOUNCED,
        blockedStatuses: [ScheduledReminderProviderStatus.DELIVERED],
        providerFailureCode: providerFailureCode || 'BOUNCED',
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.BOUNCED,
          providerFailedAt: new Date(event.created_at),
          providerFailureCode: providerFailureCode || 'BOUNCED',
        },
      } satisfies ProviderEventMapping;
    }
    case 'email.failed': {
      const providerFailureCode = event.data.failed?.reason || 'FAILED';

      return {
        auditType: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED,
        blockedStatuses: [ScheduledReminderProviderStatus.DELIVERED],
        providerFailureCode,
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.FAILED,
          providerFailedAt: new Date(event.created_at),
          providerFailureCode,
        },
      } satisfies ProviderEventMapping;
    }
    case 'email.suppressed':
      return {
        auditType: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED,
        blockedStatuses: [ScheduledReminderProviderStatus.DELIVERED],
        providerFailureCode: 'SUPPRESSED',
        update: {
          ...baseUpdate,
          providerStatus: ScheduledReminderProviderStatus.SUPPRESSED,
          providerFailedAt: new Date(event.created_at),
          providerFailureCode: 'SUPPRESSED',
        },
      } satisfies ProviderEventMapping;
  }
};

type ProviderEventMapping = {
  auditType:
    | typeof DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_DELAYED
    | typeof DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERED
    | typeof DOCUMENT_AUDIT_LOG_TYPE.REMINDER_BOUNCED
    | typeof DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED
    | null;
  blockedStatuses: ScheduledReminderProviderStatus[];
  providerFailureCode: string | null;
  update: Prisma.ScheduledReminderDeliveryUpdateManyMutationInput;
};

type ProviderAuditDelivery = {
  id: string;
  envelopeId: string;
  scheduledAt: Date;
  createdBy: { id: number; email: string; name: string | null } | null;
  recipient: { id: number; email: string; name: string; role: string };
};

const createProviderAuditLogData = (options: {
  auditType: Exclude<ProviderEventMapping['auditType'], null>;
  delivery: ProviderAuditDelivery;
  occurredAt: Date;
  providerFailureCode: string | null;
}) => {
  const { auditType, delivery, occurredAt, providerFailureCode } = options;
  const auditData = {
    recipientEmail: delivery.recipient.email,
    recipientName: delivery.recipient.name,
    recipientId: delivery.recipient.id,
    recipientRole: delivery.recipient.role,
    scheduledReminderId: delivery.id,
    scheduledAt: delivery.scheduledAt.toISOString(),
    providerEventAt: occurredAt.toISOString(),
  };

  switch (auditType) {
    case DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_DELAYED:
      return createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_DELAYED,
        envelopeId: delivery.envelopeId,
        user: delivery.createdBy,
        requestMetadata: { userAgent: 'Resend signed delivery webhook' },
        data: auditData,
      });
    case DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERED:
      return createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERED,
        envelopeId: delivery.envelopeId,
        user: delivery.createdBy,
        requestMetadata: { userAgent: 'Resend signed delivery webhook' },
        data: auditData,
      });
    case DOCUMENT_AUDIT_LOG_TYPE.REMINDER_BOUNCED:
      return createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_BOUNCED,
        envelopeId: delivery.envelopeId,
        user: delivery.createdBy,
        requestMetadata: { userAgent: 'Resend signed delivery webhook' },
        data: {
          ...auditData,
          providerFailureCode: providerFailureCode || undefined,
        },
      });
    case DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED:
      return createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED,
        envelopeId: delivery.envelopeId,
        user: delivery.createdBy,
        requestMetadata: { userAgent: 'Resend signed delivery webhook' },
        data: {
          ...auditData,
          providerFailureCode: providerFailureCode || undefined,
        },
      });
  }
};
