import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

export const DOCUMENT_NOTIFICATIONS_SWEEP_JOB_DEFINITION = {
  id: 'internal.document-notifications-sweep',
  name: 'Deliver document notifications',
  version: '1.0.0',
  trigger: { name: 'internal.document-notifications-sweep', schema: z.object({}), cron: '* * * * *' },
  handler: async () => {
    const { processDocumentNotificationDeliveries } = await import(
      '../../../server-only/notifications/document-notifications'
    );
    await processDocumentNotificationDeliveries();
  },
} as const satisfies JobDefinition<'internal.document-notifications-sweep', Record<string, never>>;
