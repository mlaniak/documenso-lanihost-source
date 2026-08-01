import { updateDocumentReminderSchedule } from '@documenso/lib/server-only/document/update-document-reminder-schedule';

import { authenticatedProcedure } from '../trpc';
import {
  updateReminderScheduleMeta,
  ZUpdateReminderScheduleRequestSchema,
  ZUpdateReminderScheduleResponseSchema,
} from './update-reminder-schedule.types';

export const updateReminderScheduleRoute = authenticatedProcedure
  .meta(updateReminderScheduleMeta)
  .input(ZUpdateReminderScheduleRequestSchema)
  .output(ZUpdateReminderScheduleResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, recipients, scheduledAt } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        recipients,
        scheduledAt,
      },
    });

    const updatedRecipients = await updateDocumentReminderSchedule({
      envelopeId,
      recipients,
      scheduledAt,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });

    return {
      success: true,
      recipients: updatedRecipients,
    };
  });
