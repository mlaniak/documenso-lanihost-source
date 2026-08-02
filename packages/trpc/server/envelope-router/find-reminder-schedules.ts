import { MAX_SCHEDULED_REMINDER_MANUAL_RETRIES } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getMemberRoles } from '@documenso/lib/server-only/team/get-member-roles';
import { isMemberManagerOrAbove } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';
import {
  type ScheduledReminderDelivery,
  ScheduledReminderDeliveryStatus,
  ScheduledReminderProviderStatus,
} from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  findReminderSchedulesMeta,
  ZFindReminderSchedulesRequestSchema,
  ZFindReminderSchedulesResponseSchema,
} from './find-reminder-schedules.types';
import { buildReminderScheduleActivity } from './reminder-schedule-activity';

export const findReminderSchedulesRoute = authenticatedProcedure
  .meta(findReminderSchedulesMeta)
  .input(ZFindReminderSchedulesRequestSchema)
  .output(ZFindReminderSchedulesResponseSchema)
  .query(async ({ input, ctx }) => {
    await assertReminderManager(ctx.teamId, ctx.user.id);

    const deliveries = await prisma.scheduledReminderDelivery.findMany({
      where: { envelope: { teamId: ctx.teamId } },
      include: {
        envelope: { select: { id: true, secondaryId: true, title: true, status: true, completedAt: true } },
        recipient: {
          select: { id: true, name: true, email: true, signingStatus: true, signedAt: true, expiresAt: true },
        },
        providerEvents: {
          select: { eventType: true, occurredAt: true },
          orderBy: { occurredAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    const grouped = new Map<string, typeof deliveries>();

    for (const delivery of deliveries) {
      const key = delivery.sequenceId ?? delivery.id;
      grouped.set(key, [...(grouped.get(key) ?? []), delivery]);
    }

    const data = [...grouped.entries()]
      .map(([id, sequence]) => {
        const ordered = [...sequence].sort((left, right) => left.sequencePosition - right.sequencePosition);
        const primary = ordered[0];
        const next = ordered.find((delivery) => delivery.status === ScheduledReminderDeliveryStatus.PENDING) ?? null;
        const failed = [...ordered]
          .reverse()
          .find((delivery) => delivery.status === ScheduledReminderDeliveryStatus.FAILED);
        const last = [...ordered].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
        const permanentProviderFailure = ordered.some((delivery) =>
          isPermanentProviderFailure(delivery.providerStatus),
        );
        const canRetry = Boolean(
          failed?.retryable &&
            failed.manualRetryCount < MAX_SCHEDULED_REMINDER_MANUAL_RETRIES &&
            !permanentProviderFailure,
        );

        return {
          id,
          sequenceId: primary.sequenceId,
          primaryDeliveryId: primary.id,
          envelopeId: primary.envelope.id,
          envelopeSecondaryId: primary.envelope.secondaryId,
          documentTitle: primary.envelope.title,
          documentStatus: primary.envelope.status,
          documentCompletedAt: primary.envelope.completedAt,
          recipient: {
            id: primary.recipient.id,
            name: primary.recipient.name,
            email: primary.recipient.email,
          },
          scheduledAt: primary.scheduledAt,
          nextDeliveryAt: next?.scheduledAt ?? null,
          timezone: primary.timezone,
          sequencePosition: ordered.filter((delivery) => delivery.status === ScheduledReminderDeliveryStatus.SENT)
            .length,
          sequenceTotal: primary.sequenceTotal,
          sequenceIntervalDays: primary.sequenceIntervalDays,
          status: getReminderScheduleStatus(ordered),
          activity: buildReminderScheduleActivity(ordered),
          lastActivityAt: last.updatedAt,
          lastErrorCode: failed?.lastErrorCode ?? last.lastErrorCode,
          lastErrorMessage: failed?.lastErrorMessage ?? last.lastErrorMessage,
          retryDeliveryId: canRetry && failed ? failed.id : null,
          canRetry,
          canCancel: ordered.some(
            (delivery) =>
              delivery.status === ScheduledReminderDeliveryStatus.PENDING ||
              delivery.status === ScheduledReminderDeliveryStatus.PROCESSING,
          ),
          canReschedule: primary.envelope.status === 'PENDING' && primary.recipient.signingStatus === 'NOT_SIGNED',
        };
      })
      .sort((left, right) => {
        if (left.nextDeliveryAt && right.nextDeliveryAt) {
          return left.nextDeliveryAt.getTime() - right.nextDeliveryAt.getTime();
        }

        if (left.nextDeliveryAt) {
          return -1;
        }

        if (right.nextDeliveryAt) {
          return 1;
        }

        return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
      });

    return { data };
  });

export const assertReminderManager = async (teamId: number, userId: number) => {
  const roles = await getMemberRoles({ teamId, reference: { type: 'User', id: userId } });

  if (!isMemberManagerOrAbove(roles.teamRole)) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Only team managers can manage reminder schedules' });
  }
};

const getReminderScheduleStatus = (deliveries: ScheduledReminderDelivery[]) => {
  if (deliveries.some((delivery) => delivery.status === ScheduledReminderDeliveryStatus.PROCESSING)) {
    return 'SENDING' as const;
  }

  if (deliveries.some((delivery) => isPermanentProviderFailure(delivery.providerStatus))) {
    return 'PERMANENT_FAILURE' as const;
  }

  if (deliveries.some((delivery) => delivery.status === ScheduledReminderDeliveryStatus.FAILED)) {
    return 'NEEDS_ATTENTION' as const;
  }

  if (deliveries.some((delivery) => delivery.status === ScheduledReminderDeliveryStatus.PENDING)) {
    return 'SCHEDULED' as const;
  }

  const latestProviderStatus = [...deliveries]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .find((delivery) => delivery.providerStatus)?.providerStatus;

  if (latestProviderStatus === ScheduledReminderProviderStatus.DELAYED) {
    return 'DELAYED' as const;
  }

  if (latestProviderStatus === ScheduledReminderProviderStatus.DELIVERED) {
    return 'DELIVERED' as const;
  }

  if (deliveries.some((delivery) => delivery.status === ScheduledReminderDeliveryStatus.SENT)) {
    return 'SUBMITTED' as const;
  }

  return 'CANCELLED' as const;
};

const isPermanentProviderFailure = (status: ScheduledReminderProviderStatus | null) =>
  status === ScheduledReminderProviderStatus.BOUNCED ||
  status === ScheduledReminderProviderStatus.FAILED ||
  status === ScheduledReminderProviderStatus.SUPPRESSED;
