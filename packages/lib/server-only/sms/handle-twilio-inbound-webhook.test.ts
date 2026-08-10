import { beforeEach, describe, expect, it, vi } from 'vitest';

const suppressPhone = vi.fn();
const getTeamSmsCredentials = vi.fn();
const verifyTwilioSignature = vi.fn();
const deleteMany = vi.fn();

vi.mock('./sms-opt-out', () => ({
  suppressPhone: (...args: unknown[]) => suppressPhone(...args),
  isPhoneSuppressed: vi.fn(),
}));

vi.mock('./sms-credentials', () => ({
  getTeamSmsCredentials: (...args: unknown[]) => getTeamSmsCredentials(...args),
}));

vi.mock('./verify-twilio-signature', () => ({
  verifyTwilioSignature: (...args: unknown[]) => verifyTwilioSignature(...args),
  buildTwilioSignature: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: { smsOptOut: { deleteMany: (...args: unknown[]) => deleteMany(...args) } },
}));

const { handleTwilioInboundWebhook } = await import('./handle-twilio-inbound-webhook');

const buildRequest = (body: Record<string, string>) =>
  new Request('http://internal.local/api/twilio/inbound-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'signature',
    },
    body: new URLSearchParams(body).toString(),
  });

describe('handleTwilioInboundWebhook', () => {
  beforeEach(() => {
    suppressPhone.mockReset();
    deleteMany.mockReset();
    getTeamSmsCredentials.mockReset().mockResolvedValue({ accountSid: 'AC_team', authToken: 'team_token' });
    verifyTwilioSignature.mockReset().mockReturnValue(true);
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
  });

  it('returns 503 when the team has no credentials configured', async () => {
    getTeamSmsCredentials.mockResolvedValue(null);

    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
      7,
    );

    expect(response.status).toBe(503);
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('returns 403 and does nothing when the signature is invalid', async () => {
    verifyTwilioSignature.mockReturnValue(false);

    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
      7,
    );

    expect(response.status).toBe(403);
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('verifies against the public url, not the request url', async () => {
    await handleTwilioInboundWebhook(buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }), 7);

    expect(verifyTwilioSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://documenso.lanihost.com/api/twilio/inbound-webhook/7',
      }),
    );
  });

  it('suppresses the sender on STOP and replies with empty twiml', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }),
      7,
    );

    expect(suppressPhone).toHaveBeenCalledWith({
      phone: '+18325551234',
      teamId: 7,
      reason: 'STOP',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');
    await expect(response.text()).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('removes the suppression on START', async () => {
    await handleTwilioInboundWebhook(buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'START' }), 7);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { phone: '+18325551234', teamId: 7 },
    });
  });

  it('replies with a help message on HELP', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'HELP' }),
      7,
    );

    await expect(response.text()).resolves.toContain('<Message>');
    expect(suppressPhone).not.toHaveBeenCalled();
  });

  it('ignores an ordinary reply without suppressing anything', async () => {
    const response = await handleTwilioInboundWebhook(
      buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'thanks!' }),
      7,
    );

    expect(response.status).toBe(200);
    expect(suppressPhone).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('verifies against the credentials of the team named in the url', async () => {
    await handleTwilioInboundWebhook(buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }), 7);

    expect(verifyTwilioSignature).toHaveBeenCalledWith(expect.objectContaining({ authToken: 'team_token' }));
    expect(suppressPhone).toHaveBeenCalledWith(expect.objectContaining({ teamId: 7 }));
  });

  it('scopes the suppression to the team in the url, not the receiving number', async () => {
    await handleTwilioInboundWebhook(buildRequest({ From: '+18325551234', To: '+18327775620', Body: 'STOP' }), 12);

    expect(suppressPhone).toHaveBeenCalledWith(expect.objectContaining({ teamId: 12 }));
  });
});
