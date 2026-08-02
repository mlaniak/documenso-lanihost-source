import { describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_OPERATIONS_SETTINGS, normalizeReminderToBusinessWindow } from './team-operations';

describe('normalizeReminderToBusinessWindow', () => {
  it('moves a Saturday reminder to Monday morning in the team timezone', () => {
    const result = normalizeReminderToBusinessWindow({
      date: new Date('2026-08-08T15:00:00.000Z'),
      timezone: 'America/Chicago',
      settings: DEFAULT_TEAM_OPERATIONS_SETTINGS,
    });

    expect(result.toISOString()).toBe('2026-08-10T14:00:00.000Z');
  });

  it('keeps an in-window weekday reminder unchanged', () => {
    const input = new Date('2026-08-05T16:30:00.000Z');
    const result = normalizeReminderToBusinessWindow({
      date: input,
      timezone: 'America/Chicago',
      settings: DEFAULT_TEAM_OPERATIONS_SETTINGS,
    });

    expect(result.toISOString()).toBe(input.toISOString());
  });
});
