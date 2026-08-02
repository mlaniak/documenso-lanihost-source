import { prisma } from '@documenso/prisma';
import { DocumentAutomationStatus, DocumentAutomationType } from '@prisma/client';
import { archiveCompletedEnvelopeToGoogleDrive } from '../../../server-only/integrations/google-drive/archive-completed-envelope';

import type { JobRunIO } from '../../client/_internal/job';

export const run = async ({ payload, io }: { payload: { envelopeId: string }; io: JobRunIO }) => {
  const idempotencyKey = `archive:${payload.envelopeId}`;
  const existing = await prisma.documentAutomationRun.findUnique({ where: { idempotencyKey } });

  if (existing?.status === DocumentAutomationStatus.COMPLETED) {
    return;
  }

  const run = await prisma.documentAutomationRun.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      envelopeId: payload.envelopeId,
      type: DocumentAutomationType.COMPLETION_ARCHIVE,
      status: DocumentAutomationStatus.PROCESSING,
      provider: 'google-drive',
    },
    update: { status: DocumentAutomationStatus.PROCESSING, error: null },
  });

  try {
    const result = await io.runTask(
      'upload-completion-packet',
      async () => await archiveCompletedEnvelopeToGoogleDrive(payload.envelopeId),
    );

    await prisma.documentAutomationRun.update({
      where: { id: run.id },
      data: result.skipped
        ? { status: DocumentAutomationStatus.SKIPPED, error: result.reason, completedAt: new Date() }
        : {
            status: DocumentAutomationStatus.COMPLETED,
            providerId: result.folderId,
            metadata: { webViewLink: result.webViewLink },
            completedAt: new Date(),
          },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'Archive failed';
    await prisma.documentAutomationRun.update({
      where: { id: run.id },
      data: { status: DocumentAutomationStatus.FAILED, error: message, completedAt: new Date() },
    });
    throw error;
  }
};
