import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTeamSettings = vi.fn();

vi.mock('../team/get-team-settings', () => ({
  getTeamSettings: (...args: unknown[]) => getTeamSettings(...args),
}));

const { getEnvelopeSmsContext } = await import('./get-envelope-sms-context');

const enabledSettings = {
  enabled: true,
  senderNumber: '+18327775620',
  defaultOn: true,
  brandLabel: 'EverTrade',
};

describe('getEnvelopeSmsContext', () => {
  beforeEach(() => {
    getTeamSettings.mockReset().mockResolvedValue({ smsSettings: enabledSettings });
  });

  it('is enabled when the team default is on and the envelope does not override', async () => {
    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: null });

    expect(context.enabled).toBe(true);
    expect(context.settings.senderNumber).toBe('+18327775620');
  });

  it('lets the envelope turn it off', async () => {
    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: false });

    expect(context.enabled).toBe(false);
  });

  it('lets the envelope turn it on when the team default is off', async () => {
    getTeamSettings.mockResolvedValue({
      smsSettings: { ...enabledSettings, defaultOn: false },
    });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(true);
  });

  it('stays disabled when the team has SMS switched off entirely, whatever the envelope says', async () => {
    getTeamSettings.mockResolvedValue({
      smsSettings: { ...enabledSettings, enabled: false },
    });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(false);
  });

  it('is disabled when the team has no sms settings', async () => {
    getTeamSettings.mockResolvedValue({ smsSettings: null });

    const context = await getEnvelopeSmsContext({ teamId: 7, documentSmsEnabled: true });

    expect(context.enabled).toBe(false);
  });
});
