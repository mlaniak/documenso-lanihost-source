import { normalisePhoneNumber } from '../../constants/sms-delivery';
import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TReminderRecipientPhone } from '../../types/recipient-phone';
import { ZRecipientPhoneSchema } from '../../types/recipient-phone';
import type { TReminderRecipientChannels } from '../../types/reminder-recipient-channels';
import { ZReminderRecipientChannelsSchema } from '../../types/reminder-recipient-channels';

/** Validate only after authorizing the envelope and loading its eligible recipients. */
export const validateReminderRecipientChannels = (options: {
  recipientIds: number[];
  eligibleRecipients: { id: number; phone?: string | null }[];
  recipientChannels: TReminderRecipientChannels;
  recipientPhones?: TReminderRecipientPhone[];
}) => {
  const parsed = ZReminderRecipientChannelsSchema.safeParse(options.recipientChannels);
  const eligibleIds = new Set(options.eligibleRecipients.map((recipient) => recipient.id));
  if (
    !parsed.success ||
    parsed.data.length !== options.recipientIds.length ||
    eligibleIds.size !== options.recipientIds.length ||
    parsed.data.some((channel) => !options.recipientIds.includes(channel.id) || !eligibleIds.has(channel.id))
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Communication methods must match eligible reminder recipients.',
    });
  }
  const channels = new Map(parsed.data.map((channel) => [channel.id, channel]));
  if (options.recipientPhones?.some((recipient) => !channels.get(recipient.id)?.sms)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Mobile numbers can only be changed for selected SMS recipients.',
    });
  }
  for (const channel of parsed.data) {
    if (!channel.sms) {
      continue;
    }
    const phone =
      options.recipientPhones?.find((recipient) => recipient.id === channel.id)?.phone ??
      options.eligibleRecipients.find((recipient) => recipient.id === channel.id)?.phone ??
      '';
    if (!ZRecipientPhoneSchema.safeParse(phone).success || !normalisePhoneNumber(phone)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Add a valid mobile number for each selected SMS recipient.',
      });
    }
  }
  return channels;
};
