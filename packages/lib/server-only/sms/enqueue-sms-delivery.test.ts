import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvelopeSmsContext = vi.fn();
const isPhoneSuppressed = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();

vi.mock('./get-envelope-sms-context', () => ({
  getEnvelopeSmsContext: (...args: unknown[]) => getEnvelopeSmsContext(...args),
}));

vi.mock('./sms-opt-out', () => ({
  isPhoneSuppressed: (...args: unknown[]) => isPhoneSuppressed(...args),
  suppressPhone: vi.fn(),
}));

const findFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: { findUnique: (...args: unknown[]) => findUnique(...args) },
    scheduledReminderDelivery: {
      create: (...args: unknown[]) => create(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

const { enqueueSmsDelivery } = await import('./enqueue-sms-delivery');

const baseOptions = {
  envelopeId: 'env-1',
  recipientId: 5,
  teamId: 7,
  documentSmsEnabled: null,
  kind: 'SIGNING_REQUEST' as const,
  createdById: 2,
};

describe('enqueueSmsDelivery', () => {
  beforeEach(() => {
    getEnvelopeSmsContext.mockReset().mockResolvedValue({
      enabled: true,
      settings: {
        enabled: true,
        senderNumber: '+18327775620',
        defaultOn: true,
        brandLabel: 'EverTrade',
      },
    });
    isPhoneSuppressed.mockReset().mockResolvedValue(false);
    findUnique.mockReset().mockResolvedValue({ phone: '+18325551234' });
    create.mockReset().mockResolvedValue({ id: 'delivery-1' });
    findFirst.mockReset().mockResolvedValue(null);
  });

  it('creates an sms ledger row due immediately', async () => {
    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('enqueued');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: 'SMS',
          kind: 'SIGNING_REQUEST',
          envelopeId: 'env-1',
          recipientId: 5,
          status: 'PENDING',
        }),
      }),
    );
  });

  it('skips when sms is disabled for the envelope', async () => {
    getEnvelopeSmsContext.mockResolvedValue({ enabled: false, settings: {} });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the recipient has no phone number', async () => {
    findUnique.mockResolvedValue({ phone: null });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the number is unusable', async () => {
    findUnique.mockResolvedValue({ phone: 'not a number' });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a suppressed number without creating a row', async () => {
    isPhoneSuppressed.mockResolvedValue(true);

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when the recipient no longer exists', async () => {
    findUnique.mockResolvedValue(null);

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a duplicate signing request while one is already pending', async () => {
    findFirst.mockResolvedValue({ id: 'existing' });

    await expect(enqueueSmsDelivery(baseOptions)).resolves.toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a second reminder even when one is pending', async () => {
    findFirst.mockResolvedValue({ id: 'existing' });

    await expect(enqueueSmsDelivery({ ...baseOptions, kind: 'REMINDER' })).resolves.toBe('enqueued');
    expect(create).toHaveBeenCalled();
  });

  it('uses a supplied context instead of resolving team settings again', async () => {
    const context = {
      enabled: true,
      settings: { enabled: true, senderNumber: '+18327775620', defaultOn: true, brandLabel: 'EverTrade' },
    };

    await enqueueSmsDelivery({ ...baseOptions, context });

    expect(getEnvelopeSmsContext).not.toHaveBeenCalled();
  });
});
