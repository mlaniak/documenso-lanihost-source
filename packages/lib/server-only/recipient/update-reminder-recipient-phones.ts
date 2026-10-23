import type { Prisma } from '@prisma/client';

import { normalisePhoneNumber } from '../../constants/sms-delivery';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TReminderRecipientPhone } from '../../types/recipient-phone';
import { ZReminderRecipientPhonesSchema } from '../../types/recipient-phone';

/** Call only after envelope authorization, inside the caller's transaction. */
export const updateReminderRecipientPhones = async (options: {
  tx: Prisma.TransactionClient;
  envelopeId: string;
  eligibleRecipientIds: number[];
  recipientPhones?: TReminderRecipientPhone[];
}) => {
  const phones = ZReminderRecipientPhonesSchema.parse(options.recipientPhones ?? []);
  const ids = phones.map((recipient) => recipient.id);

  if (new Set(ids).size !== ids.length || ids.some((id) => !options.eligibleRecipientIds.includes(id))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Mobile numbers can only be updated for selected reminder recipients',
      statusCode: 400,
    });
  }

  for (const recipient of phones) {
    const updated = await options.tx.recipient.updateMany({
      where: {
        id: recipient.id,
        envelopeId: options.envelopeId,
        signingStatus: 'NOT_SIGNED',
        role: { not: 'CC' },
        envelope: { status: 'PENDING' },
      },
      data: { phone: normalisePhoneNumber(recipient.phone) },
    });

    if (updated.count !== 1) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'This recipient can no longer receive a reminder. Refresh and try again.',
        statusCode: 409,
      });
    }
  }
};
