import type { ScheduledReminderDeliveryKind } from '@prisma/client';

import { buildCompletionSms, buildSigningRequestSms } from '../../constants/sms-delivery';
import { formatSigningLink } from '../../utils/recipients';
import { getEnvelopeSmsContext } from './get-envelope-sms-context';
import { type SendSmsResult, sendSms } from './send-sms';
import { resolveSmsCredentials } from './sms-credentials';
import { buildTwilioStatusCallbackUrl } from './twilio-webhook-urls';

export type DeliverSmsForDeliveryOptions = {
  delivery: { id: string; kind: ScheduledReminderDeliveryKind; recipientId: number };
  recipient: { phone: string | null; token: string };
  envelope: { id: string; title: string; teamId: number };
  documentSmsEnabled: boolean | null;
};

export const deliverSmsForDelivery = async (options: DeliverSmsForDeliveryOptions): Promise<SendSmsResult> => {
  // Re-checked at delivery time, not just at enqueue time: a team can switch
  // SMS off while a row sits pending.
  const context = await getEnvelopeSmsContext({
    teamId: options.envelope.teamId,
    documentSmsEnabled: options.documentSmsEnabled,
  });

  if (!context.enabled) {
    throw new Error('SMS is disabled for this envelope');
  }

  if (!options.recipient.phone) {
    throw new Error('The recipient has no phone number');
  }

  const credentials = resolveSmsCredentials(context.settings);

  if (!credentials) {
    throw new Error('No Twilio credentials are configured for this team');
  }

  const body =
    options.delivery.kind === 'COMPLETION'
      ? buildCompletionSms({
          brandLabel: context.settings.brandLabel,
          documentTitle: options.envelope.title,
          // A completion text can be the first message a number ever receives:
          // the phone may have been added, or SMS enabled, after the signing
          // request went out. Carrier rules expect opt-out language on a first
          // message, so it is always included rather than conditionally.
          includeOptOutNotice: true,
        })
      : buildSigningRequestSms({
          brandLabel: context.settings.brandLabel,
          signingUrl: formatSigningLink(options.recipient.token),
          includeOptOutNotice: true,
        });

  return await sendSms({
    to: options.recipient.phone,
    from: context.settings.senderNumber,
    body,
    teamId: options.envelope.teamId,
    credentials,
    recipientId: options.delivery.recipientId,
    // Derived per team rather than configured once. Twilio signs the callback
    // with the sending account's token, so the URL has to say which team it
    // belongs to for the receiving end to know which token to verify against.
    statusCallbackUrl: buildTwilioStatusCallbackUrl(options.envelope.teamId),
  });
};
