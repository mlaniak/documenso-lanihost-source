import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/teams';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZUpdateOperationsSettingsRequestSchema,
  ZUpdateOperationsSettingsResponseSchema,
} from './update-operations-settings.types';

export const updateOperationsSettingsRoute = authenticatedProcedure
  .input(ZUpdateOperationsSettingsRequestSchema)
  .output(ZUpdateOperationsSettingsResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const team = await prisma.team.findFirst({
      where: buildTeamWhereQuery({
        teamId: ctx.teamId,
        userId: ctx.user.id,
        roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_TEAM,
      }),
      select: { id: true, teamGlobalSettingsId: true },
    });

    if (!team) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'You do not have permission to manage operations.' });
    }

    await prisma.teamGlobalSettings.update({
      where: { id: team.teamGlobalSettingsId },
      data: { operationsSettings: input.data },
    });

    return { settings: input.data };
  });
