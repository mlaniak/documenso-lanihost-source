import { z } from 'zod';

export const ZSendTestSmsRequestSchema = z.object({
  organisationId: z.string(),
  phone: z.string().min(1).max(20),
});

export const ZSendTestSmsResponseSchema = z.object({
  providerMessageId: z.string(),
  to: z.string(),
});

export type TSendTestSmsRequest = z.infer<typeof ZSendTestSmsRequestSchema>;
export type TSendTestSmsResponse = z.infer<typeof ZSendTestSmsResponseSchema>;
