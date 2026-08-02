import { parseTeamOperationsSettings } from '@documenso/lib/types/team-operations';
import { env } from '@documenso/lib/utils/env';
import { prisma } from '@documenso/prisma';
import {
  DocumentAutomationStatus,
  DocumentAutomationType,
  DocumentStatus,
  EnvelopeType,
  ReadStatus,
  RecipientRole,
  ScheduledReminderDeliveryStatus,
  SigningStatus,
  WebhookCallStatus,
  WebhookTriggerEvents,
} from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  type TFindOperationsOverviewResponse,
  ZFindOperationsOverviewRequestSchema,
  ZFindOperationsOverviewResponseSchema,
} from './find-operations-overview.types';
import { assertReminderManager } from './find-reminder-schedules';

export const findOperationsOverviewRoute = authenticatedProcedure
  .input(ZFindOperationsOverviewRequestSchema)
  .output(ZFindOperationsOverviewResponseSchema)
  .query(async ({ input, ctx }) => {
    await assertReminderManager(ctx.teamId, ctx.user.id);

    const now = new Date();
    const since = new Date(now.getTime() - input.windowDays * 24 * 60 * 60 * 1000);

    const [team, envelopes, pendingRecipients, templates, recentWebhookFailures, archiveRuns] = await Promise.all([
      prisma.team.findUniqueOrThrow({
        where: { id: ctx.teamId },
        select: {
          teamGlobalSettings: { select: { operationsSettings: true } },
          webhooks: {
            where: { enabled: true },
            select: { eventTriggers: true },
          },
        },
      }),
      prisma.envelope.findMany({
        where: { teamId: ctx.teamId, type: EnvelopeType.DOCUMENT, createdAt: { gte: since }, deletedAt: null },
        select: { status: true, createdAt: true, completedAt: true },
      }),
      prisma.recipient.findMany({
        where: {
          envelope: {
            teamId: ctx.teamId,
            type: EnvelopeType.DOCUMENT,
            status: DocumentStatus.PENDING,
            deletedAt: null,
          },
          signingStatus: SigningStatus.NOT_SIGNED,
          role: { not: RecipientRole.CC },
        },
        select: {
          id: true,
          name: true,
          email: true,
          readStatus: true,
          sentAt: true,
          expiresAt: true,
          envelope: { select: { id: true, title: true } },
          scheduledReminderDeliveries: {
            where: { status: ScheduledReminderDeliveryStatus.FAILED },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: { sentAt: 'asc' },
        take: 200,
      }),
      prisma.envelope.findMany({
        where: { teamId: ctx.teamId, type: EnvelopeType.TEMPLATE, templateId: { not: null }, deletedAt: null },
        select: {
          id: true,
          templateId: true,
          title: true,
          updatedAt: true,
          recipients: true,
          documentMeta: { select: { signingOrder: true, distributionMethod: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 6,
      }),
      prisma.webhookCall.count({
        where: {
          webhook: { teamId: ctx.teamId },
          status: WebhookCallStatus.FAILED,
          createdAt: { gte: since },
        },
      }),
      prisma.documentAutomationRun.groupBy({
        by: ['status'],
        where: {
          envelope: { teamId: ctx.teamId },
          type: DocumentAutomationType.COMPLETION_ARCHIVE,
          createdAt: { gte: since },
        },
        _count: { _all: true },
      }),
    ]);

    const settings = parseTeamOperationsSettings(team.teamGlobalSettings.operationsSettings);
    const retentionCutoff = new Date(now.getTime() - settings.retentionDays * 24 * 60 * 60 * 1000);
    const retentionCandidateCount = await prisma.envelope.count({
      where: {
        teamId: ctx.teamId,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.COMPLETED,
        completedAt: { lt: retentionCutoff },
        deletedAt: null,
      },
    });

    const actionItems: TFindOperationsOverviewResponse['actionItems'] = [];

    for (const recipient of pendingRecipients) {
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - (recipient.sentAt?.getTime() ?? now.getTime())) / (24 * 60 * 60 * 1000)),
      );
      const base = {
        envelopeId: recipient.envelope.id,
        documentTitle: recipient.envelope.title,
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        ageDays,
        sentAt: recipient.sentAt,
        expiresAt: recipient.expiresAt,
      };

      if (recipient.scheduledReminderDeliveries.length > 0) {
        actionItems.push({ ...base, reason: 'DELIVERY_FAILED' });
        continue;
      }

      if (recipient.expiresAt && recipient.expiresAt <= now) {
        actionItems.push({ ...base, reason: 'EXPIRED' });
        continue;
      }

      if (recipient.readStatus === ReadStatus.OPENED && ageDays >= 1) {
        actionItems.push({ ...base, reason: 'OPENED_UNSIGNED' });
        continue;
      }

      if (recipient.readStatus === ReadStatus.NOT_OPENED && ageDays >= 3) {
        actionItems.push({ ...base, reason: 'NOT_OPENED' });
      }
    }

    const completed = envelopes.filter((envelope) => envelope.status === DocumentStatus.COMPLETED);
    const pending = envelopes.filter((envelope) => envelope.status === DocumentStatus.PENDING).length;
    const averageTurnaroundHours = completed.length
      ? completed.reduce(
          (total, envelope) =>
            total + ((envelope.completedAt?.getTime() ?? envelope.createdAt.getTime()) - envelope.createdAt.getTime()),
          0,
        ) /
        completed.length /
        (60 * 60 * 1000)
      : null;

    const trend = [...new Set(envelopes.map((envelope) => envelope.createdAt.toISOString().slice(0, 7)))]
      .sort()
      .map((month) => ({
        month,
        sent: envelopes.filter((envelope) => envelope.createdAt.toISOString().startsWith(month)).length,
        completed: completed.filter((envelope) => envelope.completedAt?.toISOString().startsWith(month)).length,
      }));

    const archiveCount = (status: DocumentAutomationStatus) =>
      archiveRuns.find((run) => run.status === status)?._count._all ?? 0;
    const enabledWebhookCount = team.webhooks.length;
    const hrWebhookConfigured = team.webhooks.some((webhook) =>
      webhook.eventTriggers.includes(WebhookTriggerEvents.DOCUMENT_COMPLETED),
    );

    return {
      metrics: {
        total: envelopes.length,
        pending,
        completed: completed.length,
        completionRate: envelopes.length ? (completed.length / envelopes.length) * 100 : 0,
        averageTurnaroundHours,
        needsAttention: actionItems.length,
      },
      trend,
      actionItems: actionItems.slice(0, 100),
      workflowPresets: templates.flatMap((template) =>
        template.templateId === null
          ? []
          : [
              {
                envelopeId: template.id,
                templateId: template.templateId,
                title: template.title,
                updatedAt: template.updatedAt,
                signingOrder: template.documentMeta.signingOrder,
                distributionMethod: template.documentMeta.distributionMethod,
                recipients: template.recipients.map((recipient) => ({
                  ...recipient,
                  documentId: null,
                  templateId: template.templateId,
                })),
              },
            ],
      ),
      integrations: {
        archiveProviderConfigured: Boolean(
          env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE') ||
            env('NEXT_PRIVATE_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'),
        ),
        smsProviderConfigured: Boolean(
          env('NEXT_PRIVATE_TWILIO_ACCOUNT_SID') &&
            env('NEXT_PRIVATE_TWILIO_AUTH_TOKEN') &&
            env('NEXT_PRIVATE_TWILIO_FROM_NUMBER'),
        ),
        hrWebhookConfigured,
        enabledWebhookCount,
        recentWebhookFailures,
        archiveSuccessCount: archiveCount(DocumentAutomationStatus.COMPLETED),
        archiveFailureCount: archiveCount(DocumentAutomationStatus.FAILED),
      },
      retentionCandidateCount,
      settings,
    };
  });
