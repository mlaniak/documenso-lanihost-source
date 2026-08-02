import { describe, expect, it } from 'vitest';

import { buildReminderScheduleActivity } from './reminder-schedule-activity';

const baseDelivery = {
  createdAt: new Date('2026-08-01T20:00:00.000Z'),
  scheduledAt: new Date('2026-08-01T23:10:00.000Z'),
  sentAt: new Date('2026-08-01T23:10:19.000Z'),
  failedAt: null,
  cancelledAt: null,
  sequencePosition: 1,
  providerEvents: [
    { eventType: 'email.sent', occurredAt: new Date('2026-08-01T23:10:20.000Z') },
    { eventType: 'email.delivered', occurredAt: new Date('2026-08-01T23:10:22.000Z') },
  ],
  recipient: { signedAt: new Date('2026-08-02T00:40:00.000Z') },
  envelope: { completedAt: new Date('2026-08-02T00:41:17.000Z') },
};

describe('buildReminderScheduleActivity', () => {
  it('builds an ordered, compact delivery and signing timeline', () => {
    const activity = buildReminderScheduleActivity([baseDelivery]);

    expect(activity.map((item) => item.type)).toEqual([
      'SCHEDULE_CREATED',
      'REMINDER_SUBMITTED',
      'DELIVERED',
      'RECIPIENT_SIGNED',
      'DOCUMENT_COMPLETED',
    ]);
    expect(activity[0].scheduledFor).toEqual(baseDelivery.scheduledAt);
  });

  it('deduplicates matching terminal events while keeping sequence positions distinct', () => {
    const failedAt = new Date('2026-08-01T23:15:00.000Z');
    const activity = buildReminderScheduleActivity([
      {
        ...baseDelivery,
        sentAt: null,
        failedAt,
        providerEvents: [{ eventType: 'email.failed', occurredAt: failedAt }],
        recipient: { signedAt: null },
        envelope: { completedAt: null },
      },
    ]);

    expect(activity.filter((item) => item.type === 'DELIVERY_FAILED')).toHaveLength(1);
  });
});
