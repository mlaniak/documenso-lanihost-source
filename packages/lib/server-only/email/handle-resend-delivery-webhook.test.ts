import { createHmac } from 'node:crypto';

import { verifyResendWebhook } from '@documenso/email/providers/resend-webhook';
import { ScheduledReminderProviderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import {
  mapResendDeliveryEvent,
  type ResendDeliveryEvent,
  ZResendDeliveryEventSchema,
} from './handle-resend-delivery-webhook';

const baseEvent = {
  created_at: '2026-08-01T20:30:00.000Z',
  data: {
    email_id: 'provider-email-id',
    message_id: '<scheduled-reminder-test@documenso.example.com>',
  },
};

describe('Resend scheduled reminder delivery webhooks', () => {
  it('verifies the raw signed payload and rejects a modified payload', () => {
    const secretBytes = Buffer.from('private-test-signing-key');
    const webhookSecret = `whsec_${secretBytes.toString('base64')}`;
    const webhookId = 'msg_test_delivery_event';
    const webhookTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({ ...baseEvent, type: 'email.delivered' });
    const signature = createHmac('sha256', secretBytes)
      .update(`${webhookId}.${webhookTimestamp}.${payload}`)
      .digest('base64');

    expect(
      verifyResendWebhook({
        payload,
        webhookId,
        webhookTimestamp,
        webhookSignature: `v1,${signature}`,
        webhookSecret,
      }),
    ).toEqual(JSON.parse(payload));

    expect(() =>
      verifyResendWebhook({
        payload: `${payload} `,
        webhookId,
        webhookTimestamp,
        webhookSignature: `v1,${signature}`,
        webhookSecret,
      }),
    ).toThrow();
  });

  it.each([
    ['email.sent', ScheduledReminderProviderStatus.SUBMITTED, null],
    [
      'email.delivery_delayed',
      ScheduledReminderProviderStatus.DELAYED,
      DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_DELAYED,
    ],
    ['email.delivered', ScheduledReminderProviderStatus.DELIVERED, DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERED],
    ['email.bounced', ScheduledReminderProviderStatus.BOUNCED, DOCUMENT_AUDIT_LOG_TYPE.REMINDER_BOUNCED],
    ['email.failed', ScheduledReminderProviderStatus.FAILED, DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED],
    ['email.suppressed', ScheduledReminderProviderStatus.SUPPRESSED, DOCUMENT_AUDIT_LOG_TYPE.REMINDER_DELIVERY_FAILED],
  ] as const)('maps %s to a durable provider state', (type, providerStatus, auditType) => {
    const parsedEvent = ZResendDeliveryEventSchema.parse({
      ...baseEvent,
      type,
      data: {
        ...baseEvent.data,
        bounce: type === 'email.bounced' ? { type: 'Permanent', subType: 'NoEmail', message: 'private' } : undefined,
        failed: type === 'email.failed' ? { reason: 'reached_daily_quota' } : undefined,
      },
    }) as ResendDeliveryEvent;

    const mapping = mapResendDeliveryEvent(parsedEvent);

    expect(mapping.update.providerStatus).toBe(providerStatus);
    expect(mapping.auditType).toBe(auditType);

    if (type === 'email.bounced') {
      expect(mapping.providerFailureCode).toBe('Permanent:NoEmail');
      expect(mapping.providerFailureCode).not.toContain('private');
    }
  });
});
