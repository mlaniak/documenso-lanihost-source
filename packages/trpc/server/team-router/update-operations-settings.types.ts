import { ZTeamOperationsSettings } from '@documenso/lib/types/team-operations';
import { z } from 'zod';

export const ZUpdateOperationsSettingsRequestSchema = z.object({
  data: ZTeamOperationsSettings.refine((value) => value.smartReminderEndHour > value.smartReminderStartHour, {
    message: 'Reminder end hour must be later than the start hour',
  }),
});

export const ZUpdateOperationsSettingsResponseSchema = z.object({
  settings: ZTeamOperationsSettings,
});
