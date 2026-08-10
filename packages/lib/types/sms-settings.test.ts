import { describe, expect, it } from 'vitest';

import { parseSmsSettings, redactSmsSettings, toPublicSmsSettings, ZSmsSettingsSchema } from './sms-settings';

describe('ZSmsSettingsSchema', () => {
  it('accepts a fully specified configuration', () => {
    const parsed = ZSmsSettingsSchema.parse({
      enabled: true,
      senderNumber: '+18327775620',
      defaultOn: true,
      brandLabel: 'EverTrade',
    });

    expect(parsed.senderNumber).toBe('+18327775620');
  });

  it('rejects a sender number that is not E.164', () => {
    expect(() =>
      ZSmsSettingsSchema.parse({
        enabled: true,
        senderNumber: '(832) 777-5620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      }),
    ).toThrow();
  });

  it('rejects an empty brand label', () => {
    expect(() =>
      ZSmsSettingsSchema.parse({
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: '',
      }),
    ).toThrow();
  });
});

describe('parseSmsSettings', () => {
  it('returns the parsed settings when valid', () => {
    const parsed = parseSmsSettings({
      enabled: true,
      senderNumber: '+18327775620',
      defaultOn: true,
      brandLabel: 'EverTrade',
    });

    expect(parsed.brandLabel).toBe('EverTrade');
  });

  it('falls back to disabled for null', () => {
    expect(parseSmsSettings(null).enabled).toBe(false);
  });

  it('falls back to disabled for a malformed value rather than throwing', () => {
    expect(parseSmsSettings({ enabled: 'yes' }).enabled).toBe(false);
  });
});

describe('toPublicSmsSettings', () => {
  const configured = {
    enabled: true,
    senderNumber: '+18327775620',
    defaultOn: true,
    brandLabel: 'EverTrade',
    accountSid: 'AC_team',
    authToken: 'encrypted-token',
  };

  it('never exposes the auth token', () => {
    const publicSettings = toPublicSmsSettings(configured);

    expect(publicSettings).not.toHaveProperty('authToken');
    expect(JSON.stringify(publicSettings)).not.toContain('encrypted-token');
  });

  it('reports whether a token is configured', () => {
    expect(toPublicSmsSettings(configured).hasAuthToken).toBe(true);
    expect(toPublicSmsSettings({ ...configured, authToken: undefined }).hasAuthToken).toBe(false);
  });

  it('keeps the non-secret fields', () => {
    const publicSettings = toPublicSmsSettings(configured);

    expect(publicSettings.accountSid).toBe('AC_team');
    expect(publicSettings.senderNumber).toBe('+18327775620');
  });
});

describe('redactSmsSettings', () => {
  it('removes the auth token from a settings row', () => {
    const redacted = redactSmsSettings({
      brandingEnabled: true,
      smsSettings: { accountSid: 'AC_team', authToken: 'ciphertext', senderNumber: '+18327775620' },
    });

    expect(JSON.stringify(redacted)).not.toContain('ciphertext');
    expect(redacted.smsSettings).toEqual({
      accountSid: 'AC_team',
      senderNumber: '+18327775620',
      hasAuthToken: true,
    });
  });

  it('keeps the rest of the row intact', () => {
    const redacted = redactSmsSettings({ brandingEnabled: true, smsSettings: null });

    expect(redacted.brandingEnabled).toBe(true);
    expect(redacted.smsSettings).toBeNull();
  });

  it('tolerates a null row', () => {
    expect(redactSmsSettings(null)).toBeNull();
  });

  it('reports hasAuthToken false when none is stored', () => {
    const redacted = redactSmsSettings({ smsSettings: { accountSid: 'AC_team' } });

    expect(redacted.smsSettings).toEqual({ accountSid: 'AC_team', hasAuthToken: false });
  });
});
