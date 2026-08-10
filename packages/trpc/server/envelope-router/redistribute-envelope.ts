import { resendDocument } from '@documenso/lib/server-only/document/resend-document';
import { updateDocumentMeta } from '@documenso/lib/server-only/document-meta/upsert-document-meta';
import { formatSigningLink } from '@documenso/lib/utils/recipients';

import { authenticatedProcedure } from '../trpc';
import {
  redistributeEnvelopeMeta,
  ZRedistributeEnvelopeRequestSchema,
  ZRedistributeEnvelopeResponseSchema,
} from './redistribute-envelope.types';

export const redistributeEnvelopeRoute = authenticatedProcedure
  .meta(redistributeEnvelopeMeta)
  .input(ZRedistributeEnvelopeRequestSchema)
  .output(ZRedistributeEnvelopeResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { teamId } = ctx;
    const { envelopeId, recipients, smsEnabled } = input;

    ctx.logger.info({
      input: {
        envelopeId,
        recipients,
      },
    });

    // Persisted before resending so the SMS enqueue inside resendDocument sees
    // the operator's choice for this send rather than the previous one.
    if (smsEnabled !== undefined) {
      await updateDocumentMeta({
        userId: ctx.user.id,
        teamId,
        id: { type: 'envelopeId', id: envelopeId },
        smsEnabled,
        requestMetadata: ctx.metadata,
      });
    }

    const envelope = await resendDocument({
      userId: ctx.user.id,
      teamId,
      id: {
        type: 'envelopeId',
        id: envelopeId,
      },
      recipients,
      requestMetadata: ctx.metadata,
    });

    return {
      success: true,
      id: envelope.id,
      recipients: envelope.recipients.map((recipient) => ({
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        token: recipient.token,
        role: recipient.role,
        signingOrder: recipient.signingOrder,
        signingUrl: formatSigningLink(recipient.token),
      })),
    };
  });
