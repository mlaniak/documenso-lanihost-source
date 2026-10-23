import { getTeam } from '@documenso/lib/server-only/team/get-team';
import { redactSmsSettings } from '@documenso/lib/types/sms-settings';

import { authenticatedProcedure } from '../trpc';
import { ZGetTeamRequestSchema, ZGetTeamResponseSchema } from './get-team.types';

export const getTeamRoute = authenticatedProcedure
  //   .meta(getTeamMeta)
  .input(ZGetTeamRequestSchema)
  .output(ZGetTeamResponseSchema)
  .query(async ({ input, ctx }) => {
    const { teamReference } = input;

    ctx.logger.info({
      input: {
        teamReference,
      },
    });

    const team = await getTeam({
      teamReference,
      userId: ctx.user.id,
    });
    return {
      id: team.id,
      name: team.name,
      url: team.url,
      createdAt: team.createdAt,
      avatarImageId: team.avatarImageId,
      organisationId: team.organisationId,
      currentTeamRole: team.currentTeamRole,
      teamSettings: redactSmsSettings(team.teamSettings),
      derivedSettings: redactSmsSettings(team.derivedSettings),
    };
  });
