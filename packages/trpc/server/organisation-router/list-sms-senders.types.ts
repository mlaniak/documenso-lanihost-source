import { z } from 'zod';

export const ZListSmsSendersRequestSchema = z.object({ organisationId: z.string(), teamId: z.number().optional() });
export const ZListSmsSendersResponseSchema = z.array(z.object({ phoneNumber: z.string(), friendlyName: z.string() }));
