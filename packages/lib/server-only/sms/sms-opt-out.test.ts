import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    smsOptOut: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

const { isPhoneSuppressed, suppressPhone } = await import('./sms-opt-out');

describe('isPhoneSuppressed', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('returns true when a suppression row exists', async () => {
    findUnique.mockResolvedValue({ id: 'opt-1' });

    await expect(isPhoneSuppressed({ phone: '+18325551234', teamId: 3 })).resolves.toBe(true);
  });

  it('returns false when no row exists', async () => {
    findUnique.mockResolvedValue(null);

    await expect(isPhoneSuppressed({ phone: '+18325551234', teamId: 3 })).resolves.toBe(false);
  });

  it('normalises before querying so formats cannot bypass suppression', async () => {
    findUnique.mockResolvedValue({ id: 'opt-1' });

    await isPhoneSuppressed({ phone: '(832) 555-1234', teamId: 3 });

    expect(findUnique).toHaveBeenCalledWith({
      where: { phone_teamId: { phone: '+18325551234', teamId: 3 } },
      select: { id: true },
    });
  });

  it('treats an unusable number as suppressed rather than sending to it', async () => {
    await expect(isPhoneSuppressed({ phone: 'not a phone', teamId: 3 })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('suppressPhone', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  it('upserts so a repeated STOP does not throw', async () => {
    await suppressPhone({ phone: '+18325551234', teamId: 3, reason: 'STOP' });

    expect(upsert).toHaveBeenCalledWith({
      where: { phone_teamId: { phone: '+18325551234', teamId: 3 } },
      create: { phone: '+18325551234', teamId: 3, reason: 'STOP' },
      update: { reason: 'STOP' },
    });
  });

  it('ignores an unusable number', async () => {
    await suppressPhone({ phone: 'garbage', teamId: 3, reason: 'STOP' });

    expect(upsert).not.toHaveBeenCalled();
  });
});
