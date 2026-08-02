import { z } from 'zod';

export const ZSendSigningLinkSmsRequestSchema = z.object({
  envelopeId: z.string().min(1),
  recipientId: z.number().int().positive(),
  phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use E.164 format, for example +18327773002'),
  consentConfirmed: z.literal(true),
});

export const ZSendSigningLinkSmsResponseSchema = z.object({
  deliveryId: z.string(),
  providerStatus: z.string(),
  phoneLast4: z.string(),
});
