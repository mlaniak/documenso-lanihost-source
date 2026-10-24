import { z } from 'zod';

export const ZReminderRecipientChannelsSchema = z
  .array(z.object({ id: z.number().int(), email: z.boolean(), sms: z.boolean() }))
  .min(1)
  .max(100)
  .refine((channels) => channels.every((channel) => channel.email || channel.sms), 'Select a communication method.')
  .refine(
    (channels) => new Set(channels.map((channel) => channel.id)).size === channels.length,
    'Duplicate recipient.',
  );

export type TReminderRecipientChannels = z.infer<typeof ZReminderRecipientChannelsSchema>;
