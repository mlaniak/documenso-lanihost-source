import type { DocumentStatus } from '@prisma/client';

export type ReminderNextDeliveryDisplay = {
  state: 'SCHEDULED' | 'COMPLETED' | 'INACTIVE';
  date: Date;
};

export type GetReminderNextDeliveryDisplayOptions = {
  documentStatus: DocumentStatus;
  documentCompletedAt: Date | null;
  nextDeliveryAt: Date | null;
  lastActivityAt: Date;
};

export const getReminderNextDeliveryDisplay = ({
  documentStatus,
  documentCompletedAt,
  nextDeliveryAt,
  lastActivityAt,
}: GetReminderNextDeliveryDisplayOptions): ReminderNextDeliveryDisplay => {
  if (documentStatus === 'COMPLETED') {
    return {
      state: 'COMPLETED',
      date: documentCompletedAt ?? lastActivityAt,
    };
  }

  if (nextDeliveryAt) {
    return {
      state: 'SCHEDULED',
      date: nextDeliveryAt,
    };
  }

  return {
    state: 'INACTIVE',
    date: lastActivityAt,
  };
};
