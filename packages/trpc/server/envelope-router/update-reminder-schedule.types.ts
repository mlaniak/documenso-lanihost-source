import { z } from 'zod';

import { ZSuccessResponseSchema } from '../schema';
import type { TrpcRouteMeta } from '../trpc';

export const updateReminderScheduleMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/envelope/reminder-schedule',
    summary: 'Update a reminder schedule',
    description: 'Schedule or cancel a one-off signing reminder for pending envelope recipients.',
    tags: ['Envelope'],
  },
};

export const ZUpdateReminderScheduleRequestSchema = z.object({
  envelopeId: z.string(),
  recipients: z.array(z.number()).min(1),
  scheduledAt: z.date().nullable(),
});

export const ZUpdateReminderScheduleResponseSchema = ZSuccessResponseSchema.extend({
  recipients: z.array(
    z.object({
      id: z.number(),
      scheduledReminderAt: z.date().nullable(),
      scheduledReminderCreatedAt: z.date().nullable(),
      scheduledReminderCreatedBy: z.number().nullable(),
    }),
  ),
});

export type TUpdateReminderScheduleRequest = z.infer<typeof ZUpdateReminderScheduleRequestSchema>;
export type TUpdateReminderScheduleResponse = z.infer<typeof ZUpdateReminderScheduleResponseSchema>;
