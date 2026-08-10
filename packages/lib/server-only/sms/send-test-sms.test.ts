import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueOrThrow = vi.fn();
const findFirst = vi.fn();
const sendSms = vi.fn();
const resolveSmsCredentials = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: { findUniqueOrThrow: (...a: unknown[]) => findUniqueOrThrow(...a) },
    smsOptOut: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));

vi.mock('./send-sms', () => ({ sendSms: (...a: unknown[]) => sendSms(...a) }));

vi.mock('./sms-credentials', () => ({
  resolveSmsCredentials: (...a: unknown[]) => resolveSmsCredentials(...a),
}));

const { sendTestSms } = await import('./send-test-sms');
const { SmsSendError } = await import('../../constants/sms-delivery');

const enabledSettings = {
  enabled: true,
  senderNumber: '+18327775620',
  defaultOn: true,
  brandLabel: 'EverTrade',
  accountSid: 'AC_team',
  authToken: 'ciphertext',
};

describe('sendTestSms', () => {
  beforeEach(() => {
    findUniqueOrThrow.mockReset().mockResolvedValue({
      organisationGlobalSettings: { smsSettings: enabledSettings },
      teams: [{ id: 8 }],
    });
    findFirst.mockReset().mockResolvedValue(null);
    resolveSmsCredentials.mockReset().mockReturnValue({ accountSid: 'AC_team', authToken: 'plain' });
    sendSms.mockReset().mockResolvedValue({ status: 'sent', providerMessageId: 'SM_test' });
  });

  it('sends to a normalised number and returns the twilio sid', async () => {
    const result = await sendTestSms({ organisationId: 'org-1', phone: '(832) 555-1234' });

    expect(result).toEqual({ providerMessageId: 'SM_test', to: '+18325551234' });
    expect(sendSms.mock.calls[0][0].to).toBe('+18325551234');
    expect(sendSms.mock.calls[0][0].body).toContain('EverTrade');
  });

  it('rejects an unusable number before touching twilio', async () => {
    await expect(sendTestSms({ organisationId: 'org-1', phone: 'not a number' })).rejects.toThrow(/E.164/);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('refuses when sms is not enabled', async () => {
    findUniqueOrThrow.mockResolvedValue({
      organisationGlobalSettings: { smsSettings: { ...enabledSettings, enabled: false } },
      teams: [{ id: 8 }],
    });

    await expect(sendTestSms({ organisationId: 'org-1', phone: '+18325551234' })).rejects.toThrow(/Enable SMS/);
  });

  it('refuses when no credentials resolve', async () => {
    resolveSmsCredentials.mockReturnValue(null);

    await expect(sendTestSms({ organisationId: 'org-1', phone: '+18325551234' })).rejects.toThrow(/credentials/);
  });

  it('refuses a number that opted out of any team in the organisation', async () => {
    findFirst.mockResolvedValue({ id: 'optout-1' });

    await expect(sendTestSms({ organisationId: 'org-1', phone: '+18325551234' })).rejects.toThrow(/opted out/);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('surfaces the twilio error code and message verbatim', async () => {
    sendSms.mockRejectedValue(
      new SmsSendError('The From number is not a valid phone number', { code: 21606, status: 400 }),
    );

    await expect(sendTestSms({ organisationId: 'org-1', phone: '+18325551234' })).rejects.toThrow(
      /21606.*not a valid phone number/,
    );
  });

  it('explains a provider-side opt-out in plain terms', async () => {
    sendSms.mockRejectedValue(new SmsSendError('unsubscribed', { code: 21610, status: 400 }));

    await expect(sendTestSms({ organisationId: 'org-1', phone: '+18325551234' })).rejects.toThrow(/opted out/);
  });
});
