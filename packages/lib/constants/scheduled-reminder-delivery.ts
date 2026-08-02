import { DateTime } from 'luxon';

export const MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS = 5;

export const MAX_SCHEDULED_REMINDER_SEQUENCE_DELIVERIES = 5;

export const MAX_SCHEDULED_REMINDER_SEQUENCE_INTERVAL_DAYS = 30;

export const MAX_SCHEDULED_REMINDER_MANUAL_RETRIES = 1;

export const SCHEDULED_REMINDER_CLAIM_TIMEOUT_MINUTES = 15;

export type ScheduledReminderHealthStatus =
  | 'SCHEDULED'
  | 'SENDING'
  | 'SUBMITTED'
  | 'DELAYED'
  | 'DELIVERED'
  | 'NEEDS_ATTENTION'
  | 'PERMANENT_FAILURE'
  | 'CANCELLED';

export type ScheduledReminderDeliveryHealth = {
  scheduled: number;
  sent: number;
  delivered: number;
  failed: number;
  stopped: number;
};

export const getScheduledReminderDeliveryHealth = (
  statuses: readonly ScheduledReminderHealthStatus[],
): ScheduledReminderDeliveryHealth => {
  const health: ScheduledReminderDeliveryHealth = {
    scheduled: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    stopped: 0,
  };

  for (const status of statuses) {
    if (status === 'SCHEDULED') {
      health.scheduled += 1;
    } else if (status === 'SENDING' || status === 'SUBMITTED' || status === 'DELAYED') {
      health.sent += 1;
    } else if (status === 'DELIVERED') {
      health.delivered += 1;
    } else if (status === 'NEEDS_ATTENTION' || status === 'PERMANENT_FAILURE') {
      health.failed += 1;
    } else {
      health.stopped += 1;
    }
  }

  return health;
};

export const getScheduledReminderMessageId = (deliveryId: string, appUrl: string): string => {
  const hostname = new URL(appUrl).hostname.toLowerCase();

  return `<scheduled-reminder-${deliveryId.toLowerCase()}@${hostname}>`;
};

export const getScheduledReminderIdempotencyKey = (deliveryId: string): string => `scheduled-reminder/${deliveryId}`;

export const normaliseEmailMessageId = (messageId: string): string => messageId.trim().toLowerCase();

export const getScheduledReminderRetryAt = (attemptCount: number, now = new Date()): Date => {
  const baseDelayMinutes = 5;
  const maximumDelayMinutes = 6 * 60;
  const delayMinutes = Math.min(baseDelayMinutes * 3 ** Math.max(0, attemptCount - 1), maximumDelayMinutes);

  return new Date(now.getTime() + delayMinutes * 60_000);
};

export const getScheduledReminderErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };

    return {
      code: typeof errorWithCode.code === 'string' ? errorWithCode.code : error.name || 'Error',
      message: error.message.slice(0, 500) || 'Scheduled reminder delivery failed',
    };
  }

  return {
    code: 'UnknownError',
    message: 'Scheduled reminder delivery failed',
  };
};

export const isScheduledReminderErrorRetryable = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return true;
  }

  const errorWithMetadata = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
  const status = [errorWithMetadata.statusCode, errorWithMetadata.status].find(
    (value): value is number => typeof value === 'number',
  );

  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return false;
  }

  const code = typeof errorWithMetadata.code === 'string' ? errorWithMetadata.code.toUpperCase() : '';

  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) {
    return true;
  }

  return !/(INVALID|UNAUTHORIZED|FORBIDDEN|SUPPRESSED|BOUNCED|RECIPIENT|VALIDATION)/i.test(`${code} ${error.message}`);
};

export const getScheduledReminderSequenceDates = (options: {
  scheduledAt: Date;
  timezone: string;
  total: number;
  intervalDays: number | null;
}): Date[] => {
  const { scheduledAt, timezone, total, intervalDays } = options;

  if (total < 1 || total > MAX_SCHEDULED_REMINDER_SEQUENCE_DELIVERIES) {
    throw new Error('Reminder sequence total must be between 1 and 5');
  }

  if (total > 1 && (!intervalDays || intervalDays > MAX_SCHEDULED_REMINDER_SEQUENCE_INTERVAL_DAYS)) {
    throw new Error('Reminder sequence interval must be between 1 and 30 days');
  }

  const firstDelivery = DateTime.fromJSDate(scheduledAt).setZone(timezone);

  if (!firstDelivery.isValid) {
    throw new Error('Reminder timezone is invalid');
  }

  return Array.from({ length: total }, (_, index) =>
    firstDelivery
      .plus({ days: index * (intervalDays ?? 0) })
      .toUTC()
      .toJSDate(),
  );
};
