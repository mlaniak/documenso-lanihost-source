import { prisma } from '@documenso/prisma';
import type { ScheduledReminderDeliveryKind } from '@prisma/client';

import { normalisePhoneNumber } from '../../constants/sms-delivery';
import { type EnvelopeSmsContext, getEnvelopeSmsContext } from './get-envelope-sms-context';
import { isPhoneSuppressed } from './sms-opt-out';

export type EnqueueSmsDeliveryOptions = {
  envelopeId: string;
  recipientId: number;
  teamId: number;
  documentSmsEnabled: boolean | null;
  kind: ScheduledReminderDeliveryKind;
  createdById: number | null;
  scheduledAt?: Date;
  /**
   * Pre-resolved context, so a caller looping over recipients resolves team
   * settings once instead of once per recipient.
   */
  context?: EnvelopeSmsContext;
};

/**
 * Returns 'skipped' for every expected reason a text should not go out. A
 * missing text must never fail the email it accompanies, so callers treat the
 * result as informational rather than branching on it.
 */
export const enqueueSmsDelivery = async (options: EnqueueSmsDeliveryOptions): Promise<'enqueued' | 'skipped'> => {
  const context =
    options.context ??
    (await getEnvelopeSmsContext({
      teamId: options.teamId,
      documentSmsEnabled: options.documentSmsEnabled,
    }));

  if (!context.enabled) {
    return 'skipped';
  }

  // A signing request is one-shot per recipient. Redistributing an envelope
  // three times should not text the signer three times, and the daily cap is
  // too blunt an instrument to be the only guard.
  if (options.kind !== 'REMINDER') {
    const existing = await prisma.scheduledReminderDelivery.findFirst({
      where: {
        recipientId: options.recipientId,
        channel: 'SMS',
        kind: options.kind,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      select: { id: true },
    });

    if (existing) {
      return 'skipped';
    }
  }

  const recipient = await prisma.recipient.findUnique({
    where: { id: options.recipientId },
    select: { phone: true },
  });

  const phone = recipient?.phone ? normalisePhoneNumber(recipient.phone) : null;

  if (!phone) {
    return 'skipped';
  }

  if (await isPhoneSuppressed({ phone, teamId: options.teamId })) {
    return 'skipped';
  }

  const scheduledAt = options.scheduledAt ?? new Date();

  await prisma.scheduledReminderDelivery.create({
    data: {
      channel: 'SMS',
      kind: options.kind,
      status: 'PENDING',
      scheduledAt,
      nextAttemptAt: scheduledAt,
      envelopeId: options.envelopeId,
      recipientId: options.recipientId,
      createdById: options.createdById,
    },
  });

  return 'enqueued';
};
