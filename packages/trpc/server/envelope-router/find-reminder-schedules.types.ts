import { DocumentStatus } from '@prisma/client';
import { z } from 'zod';

import type { TrpcRouteMeta } from '../trpc';

import { REMINDER_SCHEDULE_ACTIVITY_TYPES } from './reminder-schedule-activity';

export const findReminderSchedulesMeta: TrpcRouteMeta = {
  openapi: {
    method: 'GET',
    path: '/envelope/reminder-schedule',
    summary: 'List reminder schedules',
    description: 'List scheduled reminder sequences and their latest delivery state for the active team.',
    tags: ['Envelope'],
  },
};

export const ZReminderScheduleStatusSchema = z.enum([
  'SCHEDULED',
  'SENDING',
  'SUBMITTED',
  'DELAYED',
  'DELIVERED',
  'NEEDS_ATTENTION',
  'PERMANENT_FAILURE',
  'CANCELLED',
]);

export const ZReminderScheduleActivitySchema = z.object({
  type: z.enum(REMINDER_SCHEDULE_ACTIVITY_TYPES),
  occurredAt: z.date(),
  scheduledFor: z.date().nullable(),
  sequencePosition: z.number().int().nullable(),
});

export const ZFindReminderSchedulesRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(200),
});

export const ZFindReminderSchedulesResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      sequenceId: z.string().nullable(),
      primaryDeliveryId: z.string(),
      envelopeId: z.string(),
      envelopeSecondaryId: z.string(),
      documentTitle: z.string(),
      documentStatus: z.nativeEnum(DocumentStatus),
      documentCompletedAt: z.date().nullable(),
      recipient: z.object({
        id: z.number(),
        name: z.string(),
        email: z.string(),
      }),
      scheduledAt: z.date(),
      nextDeliveryAt: z.date().nullable(),
      timezone: z.string(),
      sequencePosition: z.number().int(),
      sequenceTotal: z.number().int(),
      sequenceIntervalDays: z.number().int().nullable(),
      status: ZReminderScheduleStatusSchema,
      activity: z.array(ZReminderScheduleActivitySchema),
      lastActivityAt: z.date(),
      lastErrorCode: z.string().nullable(),
      lastErrorMessage: z.string().nullable(),
      retryDeliveryId: z.string().nullable(),
      canRetry: z.boolean(),
      canCancel: z.boolean(),
      canReschedule: z.boolean(),
    }),
  ),
});

export type TFindReminderSchedulesResponse = z.infer<typeof ZFindReminderSchedulesResponseSchema>;
