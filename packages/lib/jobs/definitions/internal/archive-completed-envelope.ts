import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_ID = 'internal.archive-completed-envelope';

const ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_SCHEMA = z.object({ envelopeId: z.string() });

export const ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION = {
  id: ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_ID,
  name: 'Archive completed envelope',
  version: '1.0.0',
  trigger: {
    name: ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_ID,
    schema: ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./archive-completed-envelope.handler');
    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_ID,
  z.infer<typeof ARCHIVE_COMPLETED_ENVELOPE_JOB_DEFINITION_SCHEMA>
>;
