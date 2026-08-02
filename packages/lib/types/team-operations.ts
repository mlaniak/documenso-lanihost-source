import { DateTime } from 'luxon';
import { z } from 'zod';

export const ZTeamOperationsSettings = z.object({
  archiveEnabled: z.boolean().default(false),
  driveFolderId: z.string().trim().max(256).default(''),
  smsEnabled: z.boolean().default(false),
  smartReminderBusinessDaysOnly: z.boolean().default(true),
  smartReminderStartHour: z.number().int().min(0).max(23).default(9),
  smartReminderEndHour: z.number().int().min(1).max(24).default(17),
  retentionDays: z.number().int().min(30).max(3650).default(2555),
});

export type TTeamOperationsSettings = z.infer<typeof ZTeamOperationsSettings>;

export const DEFAULT_TEAM_OPERATIONS_SETTINGS: TTeamOperationsSettings = ZTeamOperationsSettings.parse({});

export const parseTeamOperationsSettings = (value: unknown): TTeamOperationsSettings => {
  const parsed = ZTeamOperationsSettings.safeParse(value);

  return parsed.success ? parsed.data : DEFAULT_TEAM_OPERATIONS_SETTINGS;
};

/** Move a reminder forward into the team's allowed local delivery window. */
export const normalizeReminderToBusinessWindow = ({
  date,
  timezone,
  settings,
}: {
  date: Date;
  timezone: string;
  settings: TTeamOperationsSettings;
}) => {
  let local = DateTime.fromJSDate(date, { zone: timezone });

  if (!local.isValid) {
    return date;
  }

  if (settings.smartReminderBusinessDaysOnly) {
    while (local.weekday > 5) {
      local = local.plus({ days: 1 }).startOf('day').set({ hour: settings.smartReminderStartHour });
    }
  }

  if (local.hour < settings.smartReminderStartHour) {
    local = local.startOf('day').set({ hour: settings.smartReminderStartHour });
  } else if (local.hour >= settings.smartReminderEndHour) {
    local = local.plus({ days: 1 }).startOf('day').set({ hour: settings.smartReminderStartHour });

    if (settings.smartReminderBusinessDaysOnly) {
      while (local.weekday > 5) {
        local = local.plus({ days: 1 });
      }
    }
  }

  return local.toJSDate();
};
