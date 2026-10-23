import { ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/organisations';
import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/teams';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { resolveSenderLookupCredentials } from '@documenso/lib/server-only/sms/sms-credentials';
import { getTeamSettings } from '@documenso/lib/server-only/team/get-team-settings';
import { parseSmsSettings } from '@documenso/lib/types/sms-settings';
import { buildOrganisationWhereQuery } from '@documenso/lib/utils/organisations';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import { ZListSmsSendersRequestSchema, ZListSmsSendersResponseSchema } from './list-sms-senders.types';

export const listSmsSendersRoute = authenticatedProcedure
  .input(ZListSmsSendersRequestSchema)
  .output(ZListSmsSendersResponseSchema)
  .mutation(async ({ ctx, input }) => {
    let stored: unknown;
    if (input.teamId !== undefined) {
      const team = await prisma.team.findFirst({
        where: {
          ...buildTeamWhereQuery({
            teamId: input.teamId,
            userId: ctx.user.id,
            roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_TEAM,
          }),
          organisationId: input.organisationId,
        },
        select: { id: true },
      });
      if (!team) {
        throw new AppError(AppErrorCode.UNAUTHORIZED);
      }
      stored = (await getTeamSettings({ teamId: team.id })).smsSettings;
    } else {
      const organisation = await prisma.organisation.findFirst({
        where: buildOrganisationWhereQuery({
          organisationId: input.organisationId,
          userId: ctx.user.id,
          roles: ORGANISATION_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_ORGANISATION,
        }),
        include: { organisationGlobalSettings: true },
      });
      if (!organisation) {
        throw new AppError(AppErrorCode.UNAUTHORIZED);
      }
      stored = organisation.organisationGlobalSettings.smsSettings;
    }
    const settings = parseSmsSettings(stored);
    const credentials = resolveSenderLookupCredentials(settings, input);
    if (!credentials || !/^AC[a-f0-9]{32}$/i.test(credentials.accountSid)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Enter this company’s Twilio account and token to load its sender numbers',
      });
    }
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/IncomingPhoneNumbers.json?PageSize=1000`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Twilio could not verify this account. Check the company credentials.',
      });
    }
    const data = await response.json();
    return (data.incoming_phone_numbers ?? [])
      .filter((number: { capabilities?: { sms?: boolean } }) => number.capabilities?.sms === true)
      .map((number: { phone_number: string; friendly_name: string }) => ({
        phoneNumber: number.phone_number,
        friendlyName: number.friendly_name,
      }));
  });
