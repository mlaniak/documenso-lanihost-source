import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { sendTestSms } from '@documenso/lib/server-only/sms/send-test-sms';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZSendTestSmsRequestSchema, ZSendTestSmsResponseSchema } from './send-test-sms.types';

/**
 * Send one SMS to a number the operator supplies, so a misconfiguration shows
 * up here rather than as a document notification that silently never arrives.
 *
 * Restricted to members who can manage the organisation: it spends money and
 * messages a real handset.
 */
export const sendTestSmsRoute = authenticatedProcedure
  .input(ZSendTestSmsRequestSchema)
  .output(ZSendTestSmsResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { organisationId, phone } = input;

    const organisation = await prisma.organisation.findFirst({
      where: buildOrganisationWhereQuery({
        organisationId,
        userId: ctx.user.id,
        roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_ORGANISATION'],
      }),
      select: { id: true },
    });

    if (!organisation) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You do not have permission to send a test message for this organisation.',
      });
    }

    return await sendTestSms({ organisationId: organisation.id, phone });
  });
