import { parseSmsSettings, redactSmsSettings } from '@documenso/lib/types/sms-settings';
import { getHighestOrganisationRoleInGroup } from '@documenso/lib/utils/organisations';
import { buildTeamWhereQuery, extractDerivedTeamSettings, getHighestTeamRoleInGroup } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import type { TGetOrganisationSessionResponse } from './get-organisation-session.types';
import { ZGetOrganisationSessionResponseSchema } from './get-organisation-session.types';

/**
 * Get all the organisations and teams a user belongs to.
 */
export const getOrganisationSessionRoute = authenticatedProcedure
  .output(ZGetOrganisationSessionResponseSchema)
  .query(async ({ ctx }) => {
    return await getOrganisationSession({ userId: ctx.user.id });
  });

export const getOrganisationSession = async ({
  userId,
}: {
  userId: number;
}): Promise<TGetOrganisationSessionResponse> => {
  const organisations = await prisma.organisation.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      organisationClaim: true,
      organisationGlobalSettings: true,
      subscription: true,
      groups: {
        where: {
          organisationGroupMembers: {
            some: {
              organisationMember: {
                userId,
              },
            },
          },
        },
      },
      teams: {
        where: buildTeamWhereQuery({ teamId: undefined, userId }),
        include: {
          teamGlobalSettings: true,
          teamEmail: { select: { email: true } },
          teamGroups: {
            where: {
              organisationGroup: {
                organisationGroupMembers: {
                  some: {
                    organisationMember: {
                      userId,
                    },
                  },
                },
              },
            },
            include: {
              organisationGroup: true,
            },
          },
        },
      },
    },
  });

  return organisations.map((organisation) => {
    const { organisationGlobalSettings } = organisation;

    return {
      ...organisation,
      // Session data reaches every authenticated page, so the SMS auth token is
      // stripped here. It is encrypted at rest, but ciphertext in a browser is
      // still exposure a member could collect and attack offline.
      organisationGlobalSettings: redactSmsSettings(organisationGlobalSettings),
      teams: organisation.teams.map((team) => {
        const derivedSettings = extractDerivedTeamSettings(organisationGlobalSettings, team.teamGlobalSettings);

        return {
          ...team,
          teamGlobalSettings: redactSmsSettings(team.teamGlobalSettings),
          currentTeamRole: getHighestTeamRoleInGroup(team.teamGroups),
          preferences: {
            aiFeaturesEnabled: derivedSettings.aiFeaturesEnabled,
            // Derived here so the send dialog can tick the box without a
            // second round trip. Only the non-secret parts are used.
            smsDefaultOn: (() => {
              const sms = parseSmsSettings(derivedSettings.smsSettings);

              return sms.enabled && sms.defaultOn;
            })(),
          },
        };
      }),
      currentOrganisationRole: getHighestOrganisationRoleInGroup(organisation.groups),
    };
  });
};
