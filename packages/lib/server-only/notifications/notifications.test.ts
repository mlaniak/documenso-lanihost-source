import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentNotificationSettings } from '../../types/document-notification-settings';

vi.mock('../../constants/crypto', () => ({ DOCUMENSO_ENCRYPTION_SECONDARY_KEY: 'test-encryption-key' }));
vi.mock('../../constants/app', () => ({ NEXT_PUBLIC_WEBAPP_URL: () => 'https://documents.example.com' }));
const mocks = vi.hoisted(() => ({
  getTeamSettings: vi.fn(),
  sendNtfy: vi.fn(),
  sendSms: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  envelope: vi.fn(),
  recipient: vi.fn(),
  signedRecipients: vi.fn(),
  reminderSource: vi.fn(),
}));
vi.mock('../team/get-team-settings', () => ({ getTeamSettings: mocks.getTeamSettings }));
vi.mock('./send-ntfy', () => ({ sendNtfy: mocks.sendNtfy }));
vi.mock('../sms/send-sms', () => ({ sendSms: mocks.sendSms }));
vi.mock('@documenso/prisma', () => ({
  prisma: {
    documentNotificationDelivery: {
      upsert: mocks.upsert,
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
    envelope: { findFirst: mocks.envelope, findUnique: mocks.envelope },
    scheduledReminderDelivery: { findFirst: mocks.reminderSource },
    recipient: { findUnique: mocks.recipient, findMany: mocks.signedRecipients },
  },
}));

const { emptyDocumentNotificationSettings } = await import('../../types/document-notification-settings');
const { encryptSmsAuthToken } = await import('../sms/sms-credentials');
const {
  getNotificationRoutes,
  enqueueDocumentNotification,
  processDocumentNotificationDeliveries,
  enqueueStaffDocumentNotification,
} = await import('./document-notifications');
const { mergeDocumentNotificationSettings, getNtfyOrigin, assertStaffSmsConnection } = await import('./settings');
const sms = {
  enabled: false,
  defaultOn: false,
  senderNumber: '+18325550101',
  brandLabel: 'Company A',
  accountSid: 'AC_companyA',
  authToken: encryptSmsAuthToken('company-a-token'),
};
const configured = (): DocumentNotificationSettings => {
  const settings = emptyDocumentNotificationSettings();
  return {
    ...settings,
    ntfy: { serverUrl: 'https://ntfy.lanihost.com', token: encryptSmsAuthToken('publisher') },
    signers: { ntfyEnabled: true, targets: [{ email: 'signer@example.com', topic: 'private-signer' }] },
    staff: {
      smsEnabled: true,
      phones: ['+18325550102'],
      ntfyEnabled: true,
      topic: 'private-staff',
      events: ['DOCUMENT_COMPLETED'],
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTeamSettings.mockResolvedValue({ notificationSettings: configured(), smsSettings: sms });
  mocks.recipient.mockResolvedValue({
    id: 2,
    email: 'signer@example.com',
    envelopeId: 'envelope_1',
    role: 'SIGNER',
    signingStatus: 'NOT_SIGNED',
  });
  mocks.envelope.mockResolvedValue({
    id: 'envelope_1',
    teamId: 1,
    status: 'PENDING',
    deletedAt: null,
    team: { url: 'company' },
    user: { disabled: false },
  });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.sendNtfy.mockResolvedValue(undefined);
});

describe('isolated delivery routes', () => {
  it('only routes signer push to the exact enrolled email', () => {
    expect(
      getNotificationRoutes({
        settings: configured(),
        sms,
        audience: 'SIGNER',
        event: 'SIGNING_REQUEST',
        email: 'stranger@example.com',
      }),
    ).toEqual([]);
    const routes = getNotificationRoutes({
      settings: configured(),
      sms,
      audience: 'SIGNER',
      event: 'SIGNING_REQUEST',
      email: 'SIGNER@EXAMPLE.COM',
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].destination).toBe('private-signer');
  });
  it('keeps staff SMS separate from the signer SMS switch and event selection', () => {
    expect(getNotificationRoutes({ settings: configured(), sms, audience: 'STAFF', event: 'DOCUMENT_SIGNED' })).toEqual(
      [],
    );
    const routes = getNotificationRoutes({
      settings: configured(),
      sms,
      audience: 'STAFF',
      event: 'DOCUMENT_COMPLETED',
    });
    expect(routes.map((r) => r.destination)).toEqual(['private-staff', '+18325550102']);
  });
  it('uses deterministic outbox identities and stores no recipient contact details or tokens', async () => {
    const options = {
      envelopeId: 'envelope_1',
      teamId: 1,
      audience: 'SIGNER' as const,
      event: 'SIGNING_REQUEST',
      recipientId: 2,
    };
    await enqueueDocumentNotification(options);
    await enqueueDocumentNotification(options);
    expect(mocks.upsert.mock.calls[0][0].where).toEqual(mocks.upsert.mock.calls[1][0].where);
    const stored = JSON.stringify(mocks.upsert.mock.calls[0][0]);
    expect(stored).not.toContain('signer@example.com');
    expect(stored).not.toContain('publisher');
    expect(stored).not.toContain('private-signer');
  });
  it('gives separate resends distinct push deliveries but deduplicates retries of each occurrence', async () => {
    const options = {
      envelopeId: 'envelope_1',
      teamId: 1,
      audience: 'SIGNER' as const,
      event: 'SIGNING_REQUEST',
      recipientId: 2,
    };
    await enqueueDocumentNotification(options);
    await enqueueDocumentNotification({ ...options, occurrence: 'resend:first' });
    await enqueueDocumentNotification({ ...options, occurrence: 'resend:first' });
    await enqueueDocumentNotification({ ...options, occurrence: 'resend:second' });
    const ids = mocks.upsert.mock.calls.map(([arg]) => arg.where.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[1]).not.toBe(ids[3]);
  });
  it('cancels a queued route if the company changes its topic', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: 'delivery',
        envelopeId: 'envelope_1',
        recipientId: 2,
        audience: 'SIGNER',
        channel: 'NTFY',
        event: 'SIGNING_REQUEST',
        routeKey: 'obsolete',
      },
    ]);
    await processDocumentNotificationDeliveries();
    expect(mocks.sendNtfy).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED', claimedAt: null } }),
    );
  });
  it('cancels a push when its scheduled reminder was cancelled', async () => {
    const route = getNotificationRoutes({
      settings: configured(),
      sms,
      audience: 'SIGNER',
      event: 'REMINDER',
      email: 'signer@example.com',
    })[0];
    mocks.findMany.mockResolvedValue([
      {
        id: 'delivery',
        envelopeId: 'envelope_1',
        recipientId: 2,
        audience: 'SIGNER',
        channel: 'NTFY',
        event: 'REMINDER',
        routeKey: route.key,
        nextAttemptAt: new Date(),
      },
    ]);
    mocks.reminderSource.mockResolvedValue(null);
    await processDocumentNotificationDeliveries();
    expect(mocks.sendNtfy).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED', claimedAt: null } }),
    );
  });
  it('limits signed-event alerts to the recipient who just signed', async () => {
    mocks.signedRecipients.mockResolvedValue([{ id: 2, signedAt: new Date('2026-10-23T20:00:00Z') }]);
    await enqueueStaffDocumentNotification({
      event: 'DOCUMENT_SIGNED',
      data: { envelopeId: 'envelope_1' },
      teamId: 1,
      recipientId: 2,
    });
    expect(mocks.signedRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 2 }) }),
    );
  });
  it('publishes only generic content and an authenticated inbox link for a signer', async () => {
    const route = getNotificationRoutes({
      settings: configured(),
      sms,
      audience: 'SIGNER',
      event: 'SIGNING_REQUEST',
      email: 'signer@example.com',
    })[0];
    mocks.findMany.mockResolvedValue([
      {
        id: 'delivery',
        envelopeId: 'envelope_1',
        recipientId: 2,
        audience: 'SIGNER',
        channel: 'NTFY',
        event: 'SIGNING_REQUEST',
        routeKey: route.key,
      },
    ]);
    await processDocumentNotificationDeliveries();
    expect(mocks.sendNtfy).toHaveBeenCalledWith(
      expect.objectContaining({ click: 'https://documents.example.com/inbox', topic: 'private-signer' }),
    );
    expect(mocks.sendNtfy.mock.calls[0][0].message).not.toContain('signer@example.com');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
    );
  });
  it('does not retry an uncertain provider submission', async () => {
    const route = getNotificationRoutes({
      settings: configured(),
      sms,
      audience: 'SIGNER',
      event: 'SIGNING_REQUEST',
      email: 'signer@example.com',
    })[0];
    mocks.findMany.mockResolvedValue([
      {
        id: 'delivery',
        envelopeId: 'envelope_1',
        recipientId: 2,
        audience: 'SIGNER',
        channel: 'NTFY',
        event: 'SIGNING_REQUEST',
        routeKey: route.key,
      },
    ]);
    mocks.sendNtfy.mockRejectedValue(new Error('timeout including private token'));
    await processDocumentNotificationDeliveries();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN' }) }),
    );
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('private token');
  });
});

describe('connection credentials', () => {
  it('encrypts ntfy secrets and keeps a stored token on an unrelated edit', () => {
    const form = emptyDocumentNotificationSettings();
    form.ntfy.newToken = 'plaintext-publisher';
    const first = mergeDocumentNotificationSettings(form, null);
    expect(JSON.stringify(first)).not.toContain('plaintext-publisher');
    form.ntfy.newToken = '';
    expect(mergeDocumentNotificationSettings(form, first).ntfy.token).toBe(first.ntfy.token);
  });
  it('blocks unapproved hosts and credential-bearing or redirected URLs', () => {
    for (const url of [
      'http://ntfy.lanihost.com',
      'https://attacker.example.com',
      'https://ntfy.lanihost.com/private',
      'https://secret@ntfy.lanihost.com',
    ]) {
      expect(() => getNtfyOrigin(url)).toThrow();
    }
  });
  it('never enables staff SMS with environment fallback credentials', () => {
    expect(() =>
      assertStaffSmsConnection(configured(), { ...sms, accountSid: undefined, authToken: undefined }),
    ).toThrow();
    expect(() => assertStaffSmsConnection(configured(), sms)).not.toThrow();
  });
});
