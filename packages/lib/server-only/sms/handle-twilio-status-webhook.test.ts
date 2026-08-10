import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const createMany = vi.fn();
const updateMany = vi.fn();
const verifyTwilioSignature = vi.fn();

vi.mock('./sms-credentials', () => ({
  getTeamSmsCredentials: async () => ({ accountSid: 'AC_team', authToken: 'team_token' }),
}));

vi.mock('./verify-twilio-signature', () => ({
  verifyTwilioSignature: (...args: unknown[]) => verifyTwilioSignature(...args),
  buildTwilioSignature: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    scheduledReminderDelivery: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    scheduledReminderProviderEvent: {
      createMany: (...args: unknown[]) => createMany(...args),
    },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        scheduledReminderDelivery: { updateMany: (...args: unknown[]) => updateMany(...args) },
        scheduledReminderProviderEvent: { createMany: (...args: unknown[]) => createMany(...args) },
      }),
  },
}));

const { handleTwilioStatusWebhook } = await import('./handle-twilio-status-webhook');

const buildRequest = (body: Record<string, string>) =>
  new Request('http://internal.local/api/twilio/status-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'signature',
    },
    body: new URLSearchParams(body).toString(),
  });

describe('handleTwilioStatusWebhook', () => {
  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ id: 'delivery-1' });
    createMany.mockReset().mockResolvedValue({ count: 1 });
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    verifyTwilioSignature.mockReset().mockReturnValue(true);
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.lanihost.com';
  });

  it('returns 403 on an invalid signature', async () => {
    verifyTwilioSignature.mockReturnValue(false);

    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
      7,
    );

    expect(response.status).toBe(403);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('records a delivered status against the matching delivery', async () => {
    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }),
      7,
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { providerMessageId: 'SM1' },
      select: { id: true },
    });
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ id: 'SM1:delivered', messageId: 'SM1' })],
        skipDuplicates: true,
      }),
    );
    expect(response.status).toBe(200);
  });

  it('is idempotent when the same status arrives twice', async () => {
    createMany.mockResolvedValue({ count: 0 });

    await handleTwilioStatusWebhook(buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }), 7);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('acknowledges an unknown message sid without writing', async () => {
    findUnique.mockResolvedValue(null);

    const response = await handleTwilioStatusWebhook(
      buildRequest({ MessageSid: 'SM_unknown', MessageStatus: 'delivered' }),
      7,
    );

    expect(response.status).toBe(200);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('acknowledges an ignored status without writing', async () => {
    const response = await handleTwilioStatusWebhook(buildRequest({ MessageSid: 'SM1', MessageStatus: 'read' }), 7);

    expect(response.status).toBe(200);
    expect(createMany).not.toHaveBeenCalled();
  });
});
