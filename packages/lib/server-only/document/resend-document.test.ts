import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueuePush: vi.fn(),
  envelope: vi.fn(),
  emailContext: vi.fn(),
  sendMail: vi.fn(),
  createDelivery: vi.fn(),
  updatePhones: vi.fn(),
  enqueueLegacySms: vi.fn(),
  smsContext: vi.fn(),
  nextReminder: vi.fn(),
}));
vi.mock('@documenso/email/templates/document-invite', () => ({ DocumentInviteEmailTemplate: () => null }));
vi.mock('@lingui/core/macro', () => ({ msg: (value: unknown) => value }));
vi.mock('../../client-only/providers/i18n-server', () => ({ getI18nInstance: async () => ({ _: () => 'Reminder' }) }));
vi.mock('../../utils/render-email-with-i18n', () => ({ renderEmailWithI18N: async () => 'email content' }));
vi.mock('../../types/webhook-payload', () => ({
  ZWebhookDocumentSchema: { parse: (data: unknown) => data },
  mapEnvelopeToWebhookDocumentPayload: () => ({}),
}));
vi.mock('../../utils/recipients', () => ({ isRecipientEmailValidForSending: () => true }));
vi.mock('../email/build-envelope-email-headers', () => ({ buildEnvelopeEmailHeaders: () => ({}) }));
vi.mock('../email/get-email-context', () => ({ getEmailContext: mocks.emailContext }));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: async () => ({ envelopeWhereInput: { id: 'env-1' } }),
}));
vi.mock('../recipient/update-recipient-next-reminder', () => ({ updateRecipientNextReminder: mocks.nextReminder }));
vi.mock('../recipient/update-reminder-recipient-phones', () => ({ updateReminderRecipientPhones: mocks.updatePhones }));
vi.mock('../notifications/document-notifications', () => ({ enqueueDocumentNotification: mocks.enqueuePush }));
vi.mock('../sms/enqueue-sms-delivery', () => ({ enqueueSmsDelivery: mocks.enqueueLegacySms }));
vi.mock('../sms/get-envelope-sms-context', () => ({ getEnvelopeSmsContext: mocks.smsContext }));
vi.mock('../rate-limit/assert-organisation-rates-and-limits', () => ({ assertOrganisationRatesAndLimits: vi.fn() }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('@documenso/lib/utils/document-audit-logs', () => ({ createDocumentAuditLogData: (data: unknown) => data }));
vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirstOrThrow: async () => ({ id: 1, email: 'sender@example.com', name: 'Sender', disabled: false }) },
    envelope: { findUnique: mocks.envelope },
    recipient: { updateMany: vi.fn() },
    documentAuditLog: { create: vi.fn() },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({ scheduledReminderDelivery: { create: mocks.createDelivery } }),
  },
}));

const { resendDocument } = await import('./resend-document');
const base = {
  id: { type: 'envelopeId' as const, id: 'env-1' },
  userId: 1,
  teamId: 2,
  recipients: [7],
  requestMetadata: {} as never,
};
const recipient = {
  id: 7,
  email: 'recipient@example.com',
  name: 'Recipient',
  phone: '+18325550123',
  role: 'SIGNER',
  signingStatus: 'NOT_SIGNED',
};

describe('immediate reminder communication methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueuePush.mockResolvedValue(undefined);
    process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://example.com';
    mocks.envelope.mockResolvedValue({
      id: 'env-1',
      teamId: 2,
      userId: 1,
      title: 'Test document',
      status: 'PENDING',
      recipients: [recipient],
      documentMeta: { smsEnabled: true, message: '', subject: '', envelopeExpirationPeriod: null },
      team: { name: 'Team', organisation: { organisationClaim: { recipientCount: 0 } } },
    });
    mocks.emailContext.mockResolvedValue({
      emailLanguage: 'en',
      organisationType: 'PERSONAL',
      organisationId: 'org-1',
      claims: {},
      emailsDisabled: false,
      emailTransport: { sendMail: mocks.sendMail },
    });
    mocks.smsContext.mockResolvedValue({ enabled: true });
  });
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])('honors email=%s and SMS=%s independently', async (email, sms) => {
    await resendDocument({ ...base, recipientChannels: [{ id: 7, email, sms }] });
    expect(mocks.sendMail).toHaveBeenCalledTimes(email ? 1 : 0);
    expect(mocks.emailContext).toHaveBeenCalledTimes(email ? 1 : 0);
    expect(mocks.createDelivery).toHaveBeenCalledTimes(sms ? 1 : 0);
    expect(mocks.enqueueLegacySms).not.toHaveBeenCalled();
    if (sms) {
      expect(mocks.createDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recipientId: 7, channel: 'SMS', kind: 'REMINDER', smsEnabledOverride: true }),
        }),
      );
    }
  });
  it('keeps different choices independent across two recipients', async () => {
    const envelope = await mocks.envelope();
    mocks.envelope.mockResolvedValue({
      ...envelope,
      recipients: [recipient, { ...recipient, id: 8, email: 'sms@example.com' }],
    });
    await resendDocument({
      ...base,
      recipients: [7, 8],
      recipientChannels: [
        { id: 7, email: true, sms: false },
        { id: 8, email: false, sms: true },
      ],
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: { address: 'recipient@example.com', name: 'Recipient' } }),
    );
    expect(mocks.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recipientId: 8 }) }),
    );
  });
  it('does not allow SMS selection to bypass a disabled team', async () => {
    mocks.smsContext.mockResolvedValue({ enabled: false });
    await expect(resendDocument({ ...base, recipientChannels: [{ id: 7, email: false, sms: true }] })).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.createDelivery).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
  it('rejects a signed recipient before any phone update or delivery', async () => {
    const envelope = await mocks.envelope();
    mocks.envelope.mockResolvedValue({ ...envelope, recipients: [{ ...recipient, signingStatus: 'SIGNED' }] });
    await expect(resendDocument({ ...base, recipientChannels: [{ id: 7, email: false, sms: true }] })).rejects.toThrow(
      'eligible',
    );
    expect(mocks.updatePhones).not.toHaveBeenCalled();
    expect(mocks.createDelivery).not.toHaveBeenCalled();
  });
  it('does not queue SMS when selected email fails the preflight check', async () => {
    mocks.emailContext.mockResolvedValue({ emailsDisabled: true });
    await expect(resendDocument({ ...base, recipientChannels: [{ id: 7, email: true, sms: true }] })).rejects.toThrow(
      'Email delivery is disabled',
    );
    expect(mocks.createDelivery).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
  it('does not queue a text if saving its number fails', async () => {
    mocks.updatePhones.mockRejectedValueOnce(new Error('stale phone'));
    await expect(
      resendDocument({
        ...base,
        recipientChannels: [{ id: 7, email: false, sms: true }],
        recipientPhones: [{ id: 7, phone: '8325550123' }],
      }),
    ).rejects.toThrow('stale phone');
    expect(mocks.createDelivery).not.toHaveBeenCalled();
  });
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])('preserves signer push for email=%s, SMS=%s without duplication', async (email, sms) => {
    await resendDocument({ ...base, recipientChannels: [{ id: 7, email, sms }] });
    expect(mocks.enqueuePush).toHaveBeenCalledTimes(1);
    expect(mocks.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 7,
        audience: 'SIGNER',
        event: 'SIGNING_REQUEST',
        occurrence: expect.stringMatching(/^resend:/),
      }),
    );
  });
  it('keeps push failure from preventing the selected email', async () => {
    mocks.enqueuePush.mockRejectedValueOnce(new Error('push unavailable'));
    await resendDocument({ ...base, recipientChannels: [{ id: 7, email: true, sms: false }] });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
  it('does not enqueue push after phone persistence fails', async () => {
    mocks.updatePhones.mockRejectedValueOnce(new Error('stale phone'));
    await expect(resendDocument({ ...base, recipientChannels: [{ id: 7, email: false, sms: true }] })).rejects.toThrow(
      'stale phone',
    );
    expect(mocks.enqueuePush).not.toHaveBeenCalled();
  });
});
