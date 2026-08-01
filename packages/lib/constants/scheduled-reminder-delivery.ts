export const MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS = 5;

export const SCHEDULED_REMINDER_CLAIM_TIMEOUT_MINUTES = 15;

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
