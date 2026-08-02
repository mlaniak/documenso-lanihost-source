export const REMINDER_SCHEDULE_ACTIVITY_TYPES = [
  'SCHEDULE_CREATED',
  'REMINDER_SUBMITTED',
  'DELIVERY_DELAYED',
  'DELIVERED',
  'BOUNCED',
  'DELIVERY_FAILED',
  'SUPPRESSED',
  'CANCELLED',
  'RECIPIENT_SIGNED',
  'DOCUMENT_COMPLETED',
] as const;

export type ReminderScheduleActivityType = (typeof REMINDER_SCHEDULE_ACTIVITY_TYPES)[number];

export type ReminderScheduleActivity = {
  type: ReminderScheduleActivityType;
  occurredAt: Date;
  scheduledFor: Date | null;
  sequencePosition: number | null;
};

type ReminderScheduleActivitySource = {
  createdAt: Date;
  scheduledAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  sequencePosition: number;
  providerEvents: Array<{ eventType: string; occurredAt: Date }>;
  recipient: { signedAt: Date | null };
  envelope: { completedAt: Date | null };
};

const PROVIDER_EVENT_ACTIVITY: Record<string, ReminderScheduleActivityType | undefined> = {
  'email.delivery_delayed': 'DELIVERY_DELAYED',
  'email.delivered': 'DELIVERED',
  'email.bounced': 'BOUNCED',
  'email.failed': 'DELIVERY_FAILED',
  'email.suppressed': 'SUPPRESSED',
};

export const buildReminderScheduleActivity = (
  deliveries: ReminderScheduleActivitySource[],
): ReminderScheduleActivity[] => {
  if (deliveries.length === 0) {
    return [];
  }

  const ordered = [...deliveries].sort((left, right) => left.sequencePosition - right.sequencePosition);
  const primary = ordered[0];
  const activity: ReminderScheduleActivity[] = [
    {
      type: 'SCHEDULE_CREATED',
      occurredAt: primary.createdAt,
      scheduledFor: primary.scheduledAt,
      sequencePosition: null,
    },
  ];

  for (const delivery of ordered) {
    if (delivery.sentAt) {
      activity.push({
        type: 'REMINDER_SUBMITTED',
        occurredAt: delivery.sentAt,
        scheduledFor: null,
        sequencePosition: delivery.sequencePosition,
      });
    }

    for (const providerEvent of delivery.providerEvents) {
      const type = PROVIDER_EVENT_ACTIVITY[providerEvent.eventType];

      if (type) {
        activity.push({
          type,
          occurredAt: providerEvent.occurredAt,
          scheduledFor: null,
          sequencePosition: delivery.sequencePosition,
        });
      }
    }

    if (delivery.failedAt) {
      activity.push({
        type: 'DELIVERY_FAILED',
        occurredAt: delivery.failedAt,
        scheduledFor: null,
        sequencePosition: delivery.sequencePosition,
      });
    }

    if (delivery.cancelledAt) {
      activity.push({
        type: 'CANCELLED',
        occurredAt: delivery.cancelledAt,
        scheduledFor: null,
        sequencePosition: delivery.sequencePosition,
      });
    }
  }

  if (primary.recipient.signedAt) {
    activity.push({
      type: 'RECIPIENT_SIGNED',
      occurredAt: primary.recipient.signedAt,
      scheduledFor: null,
      sequencePosition: null,
    });
  }

  if (primary.envelope.completedAt) {
    activity.push({
      type: 'DOCUMENT_COMPLETED',
      occurredAt: primary.envelope.completedAt,
      scheduledFor: null,
      sequencePosition: null,
    });
  }

  const uniqueActivity = new Map<string, ReminderScheduleActivity>();

  for (const item of activity) {
    const key = `${item.type}:${item.occurredAt.toISOString()}:${item.sequencePosition ?? ''}`;
    uniqueActivity.set(key, item);
  }

  return [...uniqueActivity.values()]
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .slice(-25);
};
