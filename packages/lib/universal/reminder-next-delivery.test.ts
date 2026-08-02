import type { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getReminderNextDeliveryDisplay } from './reminder-next-delivery';

const lastActivityAt = new Date('2026-08-01T23:10:19.963Z');
const documentCompletedAt = new Date('2026-08-02T00:41:17.293Z');
const nextDeliveryAt = new Date('2026-08-03T14:00:00.000Z');

describe('getReminderNextDeliveryDisplay', () => {
  it('shows the document completion state instead of a stale future reminder', () => {
    expect(
      getReminderNextDeliveryDisplay({
        documentStatus: 'COMPLETED' as DocumentStatus,
        documentCompletedAt,
        nextDeliveryAt,
        lastActivityAt,
      }),
    ).toEqual({
      state: 'COMPLETED',
      date: documentCompletedAt,
    });
  });

  it('shows the next delivery for an active document', () => {
    expect(
      getReminderNextDeliveryDisplay({
        documentStatus: 'PENDING' as DocumentStatus,
        documentCompletedAt: null,
        nextDeliveryAt,
        lastActivityAt,
      }),
    ).toEqual({
      state: 'SCHEDULED',
      date: nextDeliveryAt,
    });
  });

  it('shows the latest activity when no future delivery is queued', () => {
    expect(
      getReminderNextDeliveryDisplay({
        documentStatus: 'PENDING' as DocumentStatus,
        documentCompletedAt: null,
        nextDeliveryAt: null,
        lastActivityAt,
      }),
    ).toEqual({
      state: 'INACTIVE',
      date: lastActivityAt,
    });
  });
});
