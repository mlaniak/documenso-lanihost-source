import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendSms = vi.fn();
const getEnvelopeSmsContext = vi.fn();

vi.mock('./send-sms', () => ({ sendSms: (...args: unknown[]) => sendSms(...args) }));

vi.mock('./sms-credentials', () => ({
  resolveSmsCredentials: (settings: { accountSid?: string }) =>
    settings.accountSid ? { accountSid: settings.accountSid, authToken: 'decrypted' } : null,
}));

vi.mock('./get-envelope-sms-context', () => ({
  getEnvelopeSmsContext: (...args: unknown[]) => getEnvelopeSmsContext(...args),
}));

const { deliverSmsForDelivery } = await import('./deliver-sms-for-delivery');

const baseArgs = {
  delivery: { id: 'delivery-1', kind: 'SIGNING_REQUEST' as const, recipientId: 5 },
  recipient: { phone: '+18325551234', token: 'tok123' },
  envelope: { id: 'env-1', title: 'Employment Agreement', teamId: 7 },
  documentSmsEnabled: null,
};

describe('deliverSmsForDelivery', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
    sendSms.mockReset().mockResolvedValue({ status: 'sent', providerMessageId: 'SM1' });
    getEnvelopeSmsContext.mockReset().mockResolvedValue({
      enabled: true,
      settings: {
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: 'EverTrade',
        accountSid: 'AC_evertrade',
      },
    });
  });

  it('sends a signing request containing the signing link', async () => {
    await deliverSmsForDelivery(baseArgs);

    const [options] = sendSms.mock.calls[0];
    expect(options.to).toBe('+18325551234');
    expect(options.from).toBe('+18327775620');
    expect(options.body).toContain('/sign/tok123');
    expect(options.body).toContain('EverTrade');
    expect(options.recipientId).toBe(5);
  });

  it('sends a completion message naming the document', async () => {
    await deliverSmsForDelivery({
      ...baseArgs,
      delivery: { ...baseArgs.delivery, kind: 'COMPLETION' },
    });

    const [options] = sendSms.mock.calls[0];
    expect(options.body).toContain('Employment Agreement');
    expect(options.body).not.toContain('/sign/');
  });

  it('includes opt-out language on a completion message', async () => {
    await deliverSmsForDelivery({
      ...baseArgs,
      delivery: { ...baseArgs.delivery, kind: 'COMPLETION' },
    });

    const [options] = sendSms.mock.calls[0];
    expect(options.body).toContain('Reply STOP to opt out');
  });

  it('throws when sms became disabled between enqueue and delivery', async () => {
    getEnvelopeSmsContext.mockResolvedValue({ enabled: false, settings: {} });

    await expect(deliverSmsForDelivery(baseArgs)).rejects.toThrow('disabled');
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('throws when the recipient no longer has a phone number', async () => {
    await expect(deliverSmsForDelivery({ ...baseArgs, recipient: { phone: null, token: 'tok123' } })).rejects.toThrow(
      'phone',
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends with the team credentials and a team-scoped status callback', async () => {
    await deliverSmsForDelivery(baseArgs);

    const [options] = sendSms.mock.calls[0];
    expect(options.credentials).toEqual({ accountSid: 'AC_evertrade', authToken: 'decrypted' });
    expect(options.statusCallbackUrl).toBe('https://documenso.lanihost.com/api/twilio/status-webhook/7');
  });

  it('refuses to send when the team has no usable credentials', async () => {
    getEnvelopeSmsContext.mockResolvedValue({
      enabled: true,
      settings: { enabled: true, senderNumber: '+18327775620', defaultOn: true, brandLabel: 'EverTrade' },
    });

    await expect(deliverSmsForDelivery(baseArgs)).rejects.toThrow('credentials');
    expect(sendSms).not.toHaveBeenCalled();
  });
});
