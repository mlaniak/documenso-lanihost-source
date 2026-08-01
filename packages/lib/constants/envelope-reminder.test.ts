import { describe, expect, it } from 'vitest';

import { getEarliestReminderAt } from './envelope-reminder';

describe('getEarliestReminderAt', () => {
  it('returns null when no reminder dates are available', () => {
    expect(getEarliestReminderAt(null, undefined)).toBeNull();
  });

  it('returns the earliest automatic or manually scheduled reminder', () => {
    const automaticReminderAt = new Date('2026-08-05T15:00:00.000Z');
    const scheduledReminderAt = new Date('2026-08-03T14:30:00.000Z');

    expect(getEarliestReminderAt(automaticReminderAt, scheduledReminderAt)).toEqual(scheduledReminderAt);
  });
});
