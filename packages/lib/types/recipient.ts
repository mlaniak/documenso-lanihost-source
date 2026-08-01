import { RecipientSchema } from '@documenso/prisma/generated/zod/modelSchema/RecipientSchema';
import { TeamSchema } from '@documenso/prisma/generated/zod/modelSchema/TeamSchema';
import { UserSchema } from '@documenso/prisma/generated/zod/modelSchema/UserSchema';
import { ScheduledReminderDeliveryStatus, ScheduledReminderProviderStatus } from '@prisma/client';
import { z } from 'zod';

import { zEmail } from '../utils/zod';
import { ZFieldSchema } from './field';

const ZScheduledReminderDeliverySummarySchema = z.object({
  id: z.string(),
  status: z.nativeEnum(ScheduledReminderDeliveryStatus),
  scheduledAt: z.date(),
  nextAttemptAt: z.date(),
  attemptCount: z.number().int().nonnegative(),
  sentAt: z.date().nullable(),
  failedAt: z.date().nullable(),
  cancelledAt: z.date().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  providerStatus: z.nativeEnum(ScheduledReminderProviderStatus).nullable(),
  providerStatusAt: z.date().nullable(),
  providerSubmittedAt: z.date().nullable(),
  providerDelayedAt: z.date().nullable(),
  providerDeliveredAt: z.date().nullable(),
  providerFailedAt: z.date().nullable(),
  providerFailureCode: z.string().nullable(),
});

/**
 * The full recipient response schema.
 *
 * Mainly used for returning a single recipient from the API.
 */
export const ZRecipientSchema = RecipientSchema.pick({
  envelopeId: true,
  role: true,
  readStatus: true,
  signingStatus: true,
  sendStatus: true,
  id: true,
  email: true,
  name: true,
  token: true,
  documentDeletedAt: true,
  expired: true, // deprecated Not in use. To be removed in a future migration.
  expiresAt: true,
  expirationNotifiedAt: true,
  signedAt: true,
  authOptions: true,
  signingOrder: true,
  rejectionReason: true,
}).extend({
  scheduledReminderAt: z.date().nullable().optional(),
  scheduledReminderDeliveries: ZScheduledReminderDeliverySummarySchema.array().optional(),
  fields: ZFieldSchema.array(),

  // Backwards compatibility.
  documentId: z.number().nullish(),
  templateId: z.number().nullish(),
});

/**
 * A lite version of the recipient response schema without relations.
 */
export const ZRecipientLiteSchema = RecipientSchema.pick({
  envelopeId: true,
  role: true,
  readStatus: true,
  signingStatus: true,
  sendStatus: true,
  id: true,
  email: true,
  name: true,
  token: true,
  documentDeletedAt: true,
  expired: true, // !: deprecated Not in use. To be removed in a future migration.
  expiresAt: true,
  expirationNotifiedAt: true,
  signedAt: true,
  authOptions: true,
  signingOrder: true,
  rejectionReason: true,
}).extend({
  scheduledReminderAt: z.date().nullable().optional(),
  scheduledReminderDeliveries: ZScheduledReminderDeliverySummarySchema.array().optional(),
  // Backwards compatibility.
  documentId: z.number().nullish(),
  templateId: z.number().nullish(),
});

/**
 * A version of the recipient response schema when returning multiple recipients at once from a single API endpoint.
 */
export const ZRecipientManySchema = RecipientSchema.pick({
  envelopeId: true,
  role: true,
  readStatus: true,
  signingStatus: true,
  sendStatus: true,
  id: true,
  email: true,
  name: true,
  token: true,
  documentDeletedAt: true,
  expired: true, // !: deprecated Not in use. To be removed in a future migration.
  expiresAt: true,
  expirationNotifiedAt: true,
  signedAt: true,
  authOptions: true,
  signingOrder: true,
  rejectionReason: true,
}).extend({
  scheduledReminderAt: z.date().nullable().optional(),
  scheduledReminderDeliveries: ZScheduledReminderDeliverySummarySchema.array().optional(),
  user: UserSchema.pick({
    id: true,
    name: true,
    email: true,
  }),
  recipients: RecipientSchema.array(),
  team: TeamSchema.pick({
    id: true,
    url: true,
  }).nullable(),

  // Backwards compatibility.
  documentId: z.number().nullish(),
  templateId: z.number().nullish(),
});

export const ZEnvelopeRecipientSchema = ZRecipientSchema.omit({
  documentId: true,
  templateId: true,
});

export const ZEnvelopeRecipientLiteSchema = ZRecipientLiteSchema.omit({
  documentId: true,
  templateId: true,
});

export const ZEnvelopeRecipientManySchema = ZRecipientManySchema.omit({
  documentId: true,
  templateId: true,
});

export type TRecipientSchema = z.infer<typeof ZRecipientSchema>;
export type TRecipientLite = z.infer<typeof ZRecipientLiteSchema>;
export type TRecipientMany = z.infer<typeof ZRecipientManySchema>;
export type TEnvelopeRecipientSchema = z.infer<typeof ZEnvelopeRecipientSchema>;
export type TEnvelopeRecipientLite = z.infer<typeof ZEnvelopeRecipientLiteSchema>;
export type TEnvelopeRecipientMany = z.infer<typeof ZEnvelopeRecipientManySchema>;

export const ZRecipientEmailSchema = z.union([z.literal(''), zEmail('Invalid email').trim().toLowerCase().max(254)]);
