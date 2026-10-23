import { z } from 'zod';

import { normalisePhoneNumber } from '../constants/sms-delivery';

/** Blank keeps email-only delivery. Reject unusable numbers instead of silently dropping SMS. */
export const ZRecipientPhoneSchema = z
  .string()
  .trim()
  .max(30)
  .refine((phone) => phone === '' || (/^\+?[\d\s().-]+$/.test(phone) && normalisePhoneNumber(phone) !== null), {
    message: 'Enter a valid mobile number, including the country code outside the US or Canada.',
  });

export const ZReminderRecipientPhonesSchema = z
  .array(
    z.object({
      id: z.number().int(),
      phone: ZRecipientPhoneSchema,
    }),
  )
  .max(100);

export type TReminderRecipientPhone = z.infer<typeof ZReminderRecipientPhonesSchema>[number];
