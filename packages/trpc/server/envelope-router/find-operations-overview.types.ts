import { ZRecipientLiteSchema } from '@documenso/lib/types/recipient';
import { ZTeamOperationsSettings } from '@documenso/lib/types/team-operations';
import { DocumentDistributionMethod, DocumentSigningOrder } from '@prisma/client';
import { z } from 'zod';

export const ZFindOperationsOverviewRequestSchema = z.object({
  windowDays: z.number().int().min(7).max(365).default(90),
});

export const ZFindOperationsOverviewResponseSchema = z.object({
  metrics: z.object({
    total: z.number().int(),
    pending: z.number().int(),
    completed: z.number().int(),
    completionRate: z.number(),
    averageTurnaroundHours: z.number().nullable(),
    needsAttention: z.number().int(),
  }),
  trend: z.array(
    z.object({
      month: z.string(),
      sent: z.number().int(),
      completed: z.number().int(),
    }),
  ),
  actionItems: z.array(
    z.object({
      envelopeId: z.string(),
      documentTitle: z.string(),
      recipientId: z.number(),
      recipientName: z.string(),
      recipientEmail: z.string(),
      reason: z.enum(['DELIVERY_FAILED', 'EXPIRED', 'OPENED_UNSIGNED', 'NOT_OPENED']),
      ageDays: z.number().int(),
      sentAt: z.date().nullable(),
      expiresAt: z.date().nullable(),
    }),
  ),
  workflowPresets: z.array(
    z.object({
      envelopeId: z.string(),
      templateId: z.number().int(),
      title: z.string(),
      updatedAt: z.date(),
      signingOrder: z.nativeEnum(DocumentSigningOrder),
      distributionMethod: z.nativeEnum(DocumentDistributionMethod),
      recipients: z.array(ZRecipientLiteSchema),
    }),
  ),
  integrations: z.object({
    archiveProviderConfigured: z.boolean(),
    smsProviderConfigured: z.boolean(),
    hrWebhookConfigured: z.boolean(),
    enabledWebhookCount: z.number().int(),
    recentWebhookFailures: z.number().int(),
    archiveSuccessCount: z.number().int(),
    archiveFailureCount: z.number().int(),
  }),
  retentionCandidateCount: z.number().int(),
  settings: ZTeamOperationsSettings,
});

export type TFindOperationsOverviewResponse = z.infer<typeof ZFindOperationsOverviewResponseSchema>;
