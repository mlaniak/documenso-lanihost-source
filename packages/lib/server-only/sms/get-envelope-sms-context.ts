import { parseSmsSettings, type TSmsSettings } from '../../types/sms-settings';
import { getTeamSettings } from '../team/get-team-settings';

export type EnvelopeSmsContext = {
  enabled: boolean;
  settings: TSmsSettings;
};

/**
 * The team switch is a hard gate. The envelope toggle only chooses within a
 * team that has SMS turned on, so an envelope can never enable texting for a
 * team that has not configured a sender number.
 */
export const getEnvelopeSmsContext = async (options: {
  teamId: number;
  documentSmsEnabled: boolean | null;
}): Promise<EnvelopeSmsContext> => {
  const teamSettings = await getTeamSettings({ teamId: options.teamId });
  const settings = parseSmsSettings(teamSettings.smsSettings);

  const enabled = settings.enabled && (options.documentSmsEnabled ?? settings.defaultOn);

  return { enabled, settings };
};
