import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isPhoneSuppressed = vi.fn();
const suppressPhone = vi.fn();

const isRecipientSmsQuotaExceeded = vi.fn();

vi.mock('./sms-quota', () => ({
  isRecipientSmsQuotaExceeded: (...args: unknown[]) => isRecipientSmsQuotaExceeded(...args),
  MAX_SMS_PER_RECIPIENT_PER_DAY: 4,
}));

vi.mock('./sms-opt-out', () => ({
  isPhoneSuppressed: (...args: unknown[]) => isPhoneSuppressed(...args),
  suppressPhone: (...args: unknown[]) => suppressPhone(...args),
}));

const { sendSms } = await import('./send-sms');
const { SmsSendError } = await import('../../constants/sms-delivery');

const baseOptions = {
  to: '+18325551234',
  from: '+18327775620',
  body: 'EverTrade: you have a document to sign.',
  teamId: 3,
  credentials: { accountSid: 'AC_test', authToken: 'token_test' },
};

describe('sendSms', () => {
  beforeEach(() => {
    isPhoneSuppressed.mockResolvedValue(false);
    isRecipientSmsQuotaExceeded.mockReset().mockResolvedValue(false);
    suppressPhone.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns suppressed without calling twilio when the number opted out', async () => {
    isPhoneSuppressed.mockResolvedValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms(baseOptions)).resolves.toEqual({ status: 'suppressed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a form encoded body and returns the twilio sid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SM123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms(baseOptions)).resolves.toEqual({
      status: 'sent',
      providerMessageId: 'SM123',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('AC_test:token_test')}`);
    expect(init.body.toString()).toContain('To=%2B18325551234');
    expect(init.body.toString()).toContain('From=%2B18327775620');
  });

  it('throws SmsSendError carrying the twilio code on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 21211, message: 'Invalid To number' }),
      }),
    );

    await expect(sendSms(baseOptions)).rejects.toBeInstanceOf(SmsSendError);
  });

  it('records a suppression when twilio reports an unsubscribed recipient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 21610, message: 'Unsubscribed recipient' }),
      }),
    );

    await expect(sendSms(baseOptions)).rejects.toBeInstanceOf(SmsSendError);
    expect(suppressPhone).toHaveBeenCalledWith({
      phone: '+18325551234',
      teamId: 3,
      reason: 'PROVIDER_PERMANENT',
    });
  });

  it('authenticates with the credentials it was given, not the environment', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'env_token';

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ sid: 'SM7' }) });
    vi.stubGlobal('fetch', fetchMock);

    await sendSms({ ...baseOptions, credentials: { accountSid: 'AC_gulfvestor', authToken: 'gv_token' } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/Accounts/AC_gulfvestor/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${btoa('AC_gulfvestor:gv_token')}`);
  });

  it('returns throttled when the recipient hit the daily cap', async () => {
    isRecipientSmsQuotaExceeded.mockResolvedValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSms({ ...baseOptions, recipientId: 5 })).resolves.toEqual({ status: 'throttled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not enforce the cap when no recipient is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ sid: 'SM9' }) }));

    await expect(sendSms(baseOptions)).resolves.toEqual({ status: 'sent', providerMessageId: 'SM9' });
    expect(isRecipientSmsQuotaExceeded).not.toHaveBeenCalled();
  });
});

describe('provider opt-out bookkeeping', () => {
  beforeEach(() => {
    isPhoneSuppressed.mockResolvedValue(false);
    isRecipientSmsQuotaExceeded.mockReset().mockResolvedValue(false);
    suppressPhone.mockReset().mockResolvedValue(undefined);
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token_test';
  });

  const optOutResponse = {
    ok: false,
    status: 400,
    json: async () => ({ code: 21610, message: 'Unsubscribed recipient' }),
  };

  it('does not record a suppression when the caller opts out of it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(optOutResponse));

    await expect(sendSms({ ...baseOptions, suppressOnProviderOptOut: false })).rejects.toBeInstanceOf(SmsSendError);

    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('still reports the twilio error when recording the suppression fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(optOutResponse));
    suppressPhone.mockRejectedValue(new Error('foreign key constraint violated'));

    // The database problem must not replace the reason the send failed.
    await expect(sendSms(baseOptions)).rejects.toThrow(/[Uu]nsubscribed/);
  });
});
