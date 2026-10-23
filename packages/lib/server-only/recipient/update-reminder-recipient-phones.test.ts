import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { updateReminderRecipientPhones } from './update-reminder-recipient-phones';

const updateMany = vi.fn();
const tx = { recipient: { updateMany } } as unknown as Prisma.TransactionClient;
const base = { tx, envelopeId: 'envelope-a', eligibleRecipientIds: [7, 8] };

describe('reminder recipient mobile numbers', () => {
  beforeEach(() => updateMany.mockReset().mockResolvedValue({ count: 1 }));

  it('normalizes and saves only the selected pending recipient in the authorized envelope', async () => {
    await updateReminderRecipientPhones({ ...base, recipientPhones: [{ id: 7, phone: '(832) 555-0123' }] });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 7,
        envelopeId: 'envelope-a',
        signingStatus: 'NOT_SIGNED',
        role: { not: 'CC' },
        envelope: { status: 'PENDING' },
      },
      data: { phone: '+18325550123' },
    });
  });

  it('keeps saved phones when an older client omits the field', async () => {
    await updateReminderRecipientPhones(base);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('clears a number only when explicitly submitted blank', async () => {
    await updateReminderRecipientPhones({ ...base, recipientPhones: [{ id: 7, phone: '' }] });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { phone: null } }));
  });

  it('rejects an unrelated or unselected recipient before any writes', async () => {
    await expect(
      updateReminderRecipientPhones({
        ...base,
        recipientPhones: [
          { id: 7, phone: '8325550123' },
          { id: 99, phone: '8325550124' },
        ],
      }),
    ).rejects.toThrow('selected reminder recipients');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects invalid input before any writes', async () => {
    await expect(
      updateReminderRecipientPhones({
        ...base,
        recipientPhones: [
          { id: 7, phone: '8325550123' },
          { id: 8, phone: 'call me at 8325550124' },
        ],
      }),
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate recipients before any writes', async () => {
    await expect(
      updateReminderRecipientPhones({
        ...base,
        recipientPhones: [
          { id: 7, phone: '8325550123' },
          { id: 7, phone: '' },
        ],
      }),
    ).rejects.toThrow('selected reminder recipients');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('fails if the recipient signed or the envelope changed since it was loaded', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      updateReminderRecipientPhones({ ...base, recipientPhones: [{ id: 7, phone: '8325550123' }] }),
    ).rejects.toThrow('no longer receive a reminder');
  });
});
