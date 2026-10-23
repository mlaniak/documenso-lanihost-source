import { z } from 'zod';

export const ZListSmsSendersRequestSchema = z.object({
  organisationId: z.string(),
  teamId: z.number().optional(),
  accountSid: z.string().optional(),
  newAuthToken: z.string().optional(),
});
export const ZListSmsSendersResponseSchema = z.array(z.object({ phoneNumber: z.string(), friendlyName: z.string() }));
