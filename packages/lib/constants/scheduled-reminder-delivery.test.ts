import { describe, expect, it } from 'vitest';

import {
  getScheduledReminderErrorDetails,
  getScheduledReminderIdempotencyKey,
  getScheduledReminderMessageId,
  getScheduledReminderRetryAt,
  getScheduledReminderSequenceDates,
  isScheduledReminderErrorRetryable,
  MAX_SCHEDULED_REMINDER_DELIVERY_ATTEMPTS,
  normaliseEmailMessageId,
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

  it('builds stable provider correlation and idempotency identifiers', () => {
    expect(getScheduledReminderMessageId('Delivery_123', 'https://DOCUMENSO.Example.com/path')).toBe(
      '<scheduled-reminder-delivery_123@documenso.example.com>',
    );
    expect(getScheduledReminderIdempotencyKey('Delivery_123')).toBe('scheduled-reminder/Delivery_123');
    expect(normaliseEmailMessageId('  <Scheduled-Reminder@Example.COM> ')).toBe('<scheduled-reminder@example.com>');
  });

  it('normalises and truncates delivery errors', () => {
    const error = Object.assign(new Error('x'.repeat(700)), { code: 'SMTP_TEMPORARY' });

    expect(getScheduledReminderErrorDetails(error)).toEqual({
      code: 'SMTP_TEMPORARY',
      message: 'x'.repeat(500),
    });
  });
});

describe('getScheduledReminderSequenceDates', () => {
  it('preserves the local wall-clock time across daylight-saving changes', () => {
    const dates = getScheduledReminderSequenceDates({
      scheduledAt: new Date('2026-10-31T14:30:00.000Z'),
      timezone: 'America/Chicago',
      total: 3,
      intervalDays: 1,
    });

    expect(dates.map((date) => date.toISOString())).toEqual([
      '2026-10-31T14:30:00.000Z',
      '2026-11-01T15:30:00.000Z',
      '2026-11-02T15:30:00.000Z',
    ]);
  });
});

describe('isScheduledReminderErrorRetryable', () => {
  it('retries transient provider and network failures', () => {
    expect(isScheduledReminderErrorRetryable(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true);
    expect(isScheduledReminderErrorRetryable(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('does not retry permanent recipient failures', () => {
    expect(isScheduledReminderErrorRetryable(Object.assign(new Error('Invalid recipient'), { statusCode: 422 }))).toBe(
      false,
    );
    expect(isScheduledReminderErrorRetryable(new Error('Recipient address suppressed'))).toBe(false);
  });
});
