import { prisma } from '@documenso/prisma';
import type { SmsOptOutReason } from '@prisma/client';

import { normalisePhoneNumber } from '../../constants/sms-delivery';

/**
 * An unusable number resolves to suppressed. Failing closed means a malformed
 * value is skipped rather than handed to the provider.
 */
export const isPhoneSuppressed = async (options: { phone: string; teamId: number }): Promise<boolean> => {
  const phone = normalisePhoneNumber(options.phone);

  if (!phone) {
    return true;
  }

  const suppression = await prisma.smsOptOut.findUnique({
    where: { phone_teamId: { phone, teamId: options.teamId } },
    select: { id: true },
  });

  return suppression !== null;
};

export const suppressPhone = async (options: {
  phone: string;
  teamId: number;
  reason: SmsOptOutReason;
}): Promise<void> => {
  const phone = normalisePhoneNumber(options.phone);

  if (!phone) {
    return;
  }

  await prisma.smsOptOut.upsert({
    where: { phone_teamId: { phone, teamId: options.teamId } },
    create: { phone, teamId: options.teamId, reason: options.reason },
    update: { reason: options.reason },
  });
};
