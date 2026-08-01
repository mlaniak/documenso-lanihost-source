import { describe, expect, it } from 'vitest';

import {
  getScheduledReminderErrorDetails,
  getScheduledReminderRetryAt,
  MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS,
} from './scheduled-reminder-delivery';

describe('scheduled reminder delivery', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  it.each([
    [1, '2026-08-01T12:05:00.000Z'],
    [2, '2026-08-01T12:15:00.000Z'],
    [3, '2026-08-01T12:45:00.000Z'],
    [4, '2026-08-01T14:15:00.000Z'],
    [5, '2026-08-01T18:00:00.000Z'],
  ])('backs attempt %i off until %s', (attemptCount, expected) => {
    expect(getScheduledReminderRetryAt(attemptCount, now).toISOString()).toBe(expected);
  });

  it('caps retries at five attempts', () => {
    expect(MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS).toBe(5);
  });

  it('normalises and truncates delivery errors', () => {
    const error = Object.assign(new Error('x'.repeat(700)), { code: 'SMTP_TEMPORARY' });

    expect(getScheduledReminderErrorDetails(error)).toEqual({
      code: 'SMTP_TEMPORARY',
      message: 'x'.repeat(500),
    });
  });
});
