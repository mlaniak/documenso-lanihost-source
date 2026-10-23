import type { WebhookTriggerEvents } from '@prisma/client';
import { jobs } from '../../../jobs/client';
import { enqueueStaffDocumentNotification } from '../../notifications/document-notifications';
import { getAllWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';

export type TriggerWebhookOptions = {
  event: WebhookTriggerEvents;
  data: Record<string, unknown>;
  userId: number;
  teamId: number;
  recipientId?: number;
};

export const triggerWebhook = async ({ event, data, userId, teamId, recipientId }: TriggerWebhookOptions) => {
  await enqueueStaffDocumentNotification({ event, data, teamId, recipientId }).catch(() => {
    console.error('Could not queue internal document notification');
  });
  try {
    const registeredWebhooks = await getAllWebhooksByEventTrigger({ event, userId, teamId });

    if (registeredWebhooks.length === 0) {
      return;
    }

    await Promise.allSettled(
      registeredWebhooks.map(async (webhook) => {
        await jobs.triggerJob({
          name: 'internal.execute-webhook',
          payload: {
            event,
            webhookId: webhook.id,
            data,
          },
        });
      }),
    );
  } catch (err) {
    console.error(err);
    throw new Error(`Failed to trigger webhook`);
  }
};
