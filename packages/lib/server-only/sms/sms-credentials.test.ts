import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../constants/crypto', () => ({
  DOCUMENSO_ENCRYPTION_SECONDARY_KEY: 'test-encryption-key',
}));

const { decryptSmsAuthToken, encryptSmsAuthToken, resolveSmsCredentials } = await import('./sms-credentials');

describe('sms auth token encryption', () => {
  it('round trips a token', () => {
    const encrypted = encryptSmsAuthToken('super_secret_token');

    expect(encrypted).not.toContain('super_secret_token');
    expect(decryptSmsAuthToken(encrypted)).toBe('super_secret_token');
  });

  it('produces different ciphertext for the same input', () => {
    expect(encryptSmsAuthToken('same')).not.toBe(encryptSmsAuthToken('same'));
  });
});

describe('resolveSmsCredentials', () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it('prefers the stored per-team credentials', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'env_token';

    const credentials = resolveSmsCredentials({
      accountSid: 'AC_team',
      authToken: encryptSmsAuthToken('team_token'),
    });

    expect(credentials).toEqual({ accountSid: 'AC_team', authToken: 'team_token' });
  });

  it('falls back to environment credentials when the team has none', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'env_token';

    expect(resolveSmsCredentials({})).toEqual({ accountSid: 'AC_env', authToken: 'env_token' });
  });

  it('returns null when neither source is configured', () => {
    expect(resolveSmsCredentials({})).toBeNull();
  });

  it('returns null rather than mixing a team sid with an environment token', () => {
    process.env.TWILIO_AUTH_TOKEN = 'env_token';

    expect(resolveSmsCredentials({ accountSid: 'AC_team' })).toBeNull();
  });

  it('returns null when the stored token cannot be decrypted', () => {
    expect(resolveSmsCredentials({ accountSid: 'AC_team', authToken: 'not-valid-ciphertext' })).toBeNull();
  });
});
