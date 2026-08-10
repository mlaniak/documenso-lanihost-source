import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../constants/crypto', () => ({
  DOCUMENSO_ENCRYPTION_SECONDARY_KEY: 'test-encryption-key',
}));

const { decryptSmsAuthToken, encryptSmsAuthToken, mergeSmsSettingsForStorage } = await import('./sms-credentials');

const submitted = {
  enabled: true,
  senderNumber: '+18327775620',
  defaultOn: true,
  brandLabel: 'EverTrade',
  accountSid: 'AC_team',
};

describe('mergeSmsSettingsForStorage', () => {
  let storedToken: string;

  beforeEach(() => {
    storedToken = encryptSmsAuthToken('original_token');
  });

  it('keeps the stored token when none is submitted', () => {
    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, newAuthToken: '' },
      stored: { authToken: storedToken, brandLabel: 'Old' },
    });

    expect(merged.authToken).toBe(storedToken);
    expect(merged.brandLabel).toBe('EverTrade');
  });

  it('replaces the token when a new one is submitted', () => {
    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, newAuthToken: 'replacement_token' },
      stored: { authToken: storedToken },
    });

    expect(merged.authToken).not.toBe(storedToken);
    expect(decryptSmsAuthToken(String(merged.authToken))).toBe('replacement_token');
  });

  it('encrypts the submitted token rather than storing it in the clear', () => {
    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, newAuthToken: 'plaintext_secret' },
      stored: null,
    });

    expect(JSON.stringify(merged)).not.toContain('plaintext_secret');
  });

  it('refuses an enabled configuration with neither a stored nor a submitted token', () => {
    // Storing this would look saved but never send. The guard lives on the
    // server because only it can see whether a token is already stored.
    expect(() => mergeSmsSettingsForStorage({ submitted, stored: null })).toThrow(/auth token is required/i);
  });

  it('never writes back the hasAuthToken flag the client sends', () => {
    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, newAuthToken: 'tok' },
      stored: { authToken: storedToken, hasAuthToken: true },
    });

    expect(merged).not.toHaveProperty('hasAuthToken');
  });
});

describe('mergeSmsSettingsForStorage guard', () => {
  it('allows an edit that does not re-enter the token', () => {
    const stored = { authToken: encryptSmsAuthToken('kept_token') };

    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, brandLabel: 'EverTrade', newAuthToken: '' },
      stored,
    });

    expect(merged.brandLabel).toBe('EverTrade');
    expect(merged.authToken).toBe(stored.authToken);
  });

  it('refuses to enable sms with no token stored or submitted', () => {
    expect(() => mergeSmsSettingsForStorage({ submitted: { ...submitted, enabled: true }, stored: null })).toThrow(
      /auth token is required/i,
    );
  });

  it('allows saving a disabled configuration without a token', () => {
    const merged = mergeSmsSettingsForStorage({
      submitted: { ...submitted, enabled: false },
      stored: null,
    });

    expect(merged.enabled).toBe(false);
  });
});
