import { DocumentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { ZFindReminderSchedulesResponseSchema } from './find-reminder-schedules.types';

const completedSchedule = {
  id: 'sequence-1',
  sequenceId: 'sequence-1',
  primaryDeliveryId: 'delivery-1',
  envelopeId: 'envelope-1',
  envelopeSecondaryId: 'secondary-1',
  documentTitle: 'Completed agreement.pdf',
  documentStatus: DocumentStatus.COMPLETED,
  documentCompletedAt: new Date('2026-08-02T00:41:17.293Z'),
  recipient: {
    id: 1,
    name: 'Recipient',
    email: 'recipient@example.com',
  },
  scheduledAt: new Date('2026-08-01T23:10:00.000Z'),
  nextDeliveryAt: null,
  timezone: 'America/Chicago',
  sequencePosition: 1,
  sequenceTotal: 1,
  sequenceIntervalDays: null,
  status: 'SUBMITTED' as const,
  lastActivityAt: new Date('2026-08-01T23:10:19.963Z'),
  lastErrorCode: null,
  lastErrorMessage: null,
  retryDeliveryId: null,
  canRetry: false,
  canCancel: false,
  canReschedule: false,
};

describe('ZFindReminderSchedulesResponseSchema', () => {
  it('keeps completed document state separate from submitted email delivery state', () => {
    const result = ZFindReminderSchedulesResponseSchema.parse({ data: [completedSchedule] });

    expect(result.data[0]).toMatchObject({
      documentStatus: DocumentStatus.COMPLETED,
      status: 'SUBMITTED',
      canRetry: false,
      canCancel: false,
      canReschedule: false,
    });
  });

  it('rejects an unknown document status', () => {
    const result = ZFindReminderSchedulesResponseSchema.safeParse({
      data: [{ ...completedSchedule, documentStatus: 'FULLY_EXECUTED' }],
    });

    expect(result.success).toBe(false);
  });
});
