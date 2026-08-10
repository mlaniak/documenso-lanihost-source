import { prisma } from '@documenso/prisma';

import { mapTwilioMessageStatus } from '../../constants/sms-delivery';
import { getTeamSmsCredentials } from './sms-credentials';
import { buildTwilioStatusCallbackUrl } from './twilio-webhook-urls';
import { verifyTwilioSignature } from './verify-twilio-signature';

const MAX_TWILIO_WEBHOOK_BYTES = 16 * 1024;

export const handleTwilioStatusWebhook = async (request: Request, teamId: number): Promise<Response> => {
  const credentials = await getTeamSmsCredentials(teamId);

  if (!credentials) {
    return new Response('Webhook unavailable', { status: 503 });
  }

  const rawBody = await request.text();

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const url = buildTwilioStatusCallbackUrl(teamId);

  const isValid = verifyTwilioSignature({
    url,
    params,
    authToken: credentials.authToken,
    signature: request.headers.get('x-twilio-signature'),
  });

  if (!isValid) {
    return new Response('Invalid signature', { status: 403 });
  }

  const messageSid = params.MessageSid ?? '';
  const rawStatus = params.MessageStatus ?? '';
  const providerStatus = mapTwilioMessageStatus(rawStatus);

  // Acknowledge statuses we ignore, so Twilio does not retry them.
  if (!messageSid || !providerStatus) {
    return Response.json({ received: true, processed: false });
  }

  const delivery = await prisma.scheduledReminderDelivery.findUnique({
    where: { providerMessageId: messageSid },
    select: { id: true },
  });

  if (!delivery) {
    return Response.json({ received: true, processed: false });
  }

  const occurredAt = new Date();
  const normalisedStatus = rawStatus.trim().toLowerCase();

  const processed = await prisma.$transaction(async (tx) => {
    const inserted = await tx.scheduledReminderProviderEvent.createMany({
      data: [
        {
          id: `${messageSid}:${normalisedStatus}`,
          eventType: normalisedStatus,
          occurredAt,
          messageId: messageSid,
          deliveryId: delivery.id,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      return false;
    }

    await tx.scheduledReminderDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        providerStatus,
        providerStatusAt: occurredAt,
        ...(providerStatus === 'DELIVERED' ? { providerDeliveredAt: occurredAt } : {}),
        ...(providerStatus === 'BOUNCED' || providerStatus === 'FAILED'
          ? { providerFailedAt: occurredAt, providerFailureCode: params.ErrorCode ?? null }
          : {}),
      },
    });

    return true;
  });

  return Response.json({ received: true, processed });
};
