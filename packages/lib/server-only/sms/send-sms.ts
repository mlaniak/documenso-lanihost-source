import { getSmsSegmentCount, SmsSendError, TWILIO_OPT_OUT_ERROR_CODE } from '../../constants/sms-delivery';
import { logger } from '../../utils/logger';
import type { SmsCredentials } from './sms-credentials';
import { isPhoneSuppressed, suppressPhone } from './sms-opt-out';
import { isRecipientSmsQuotaExceeded } from './sms-quota';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export type SendSmsOptions = {
  to: string;
  from: string;
  body: string;
  teamId: number;
  /**
   * Resolved by the caller, because each business verifies its own Twilio
   * account and the sending number belongs to exactly one of them.
   */
  credentials: SmsCredentials;
  statusCallbackUrl?: string;
  /** When supplied, the per-recipient daily cap is enforced. */
  recipientId?: number;
  /**
   * Record a local suppression when Twilio reports the recipient unsubscribed.
   * Off for diagnostics that have no real team to attribute it to.
   */
  suppressOnProviderOptOut?: boolean;
};

export type SendSmsResult =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'suppressed' }
  | { status: 'throttled' };

export const sendSms = async (options: SendSmsOptions): Promise<SendSmsResult> => {
  const { accountSid, authToken } = options.credentials;

  if (await isPhoneSuppressed({ phone: options.to, teamId: options.teamId })) {
    return { status: 'suppressed' };
  }

  if (options.recipientId !== undefined && (await isRecipientSmsQuotaExceeded({ recipientId: options.recipientId }))) {
    logger.warn({
      msg: 'Skipping SMS because the recipient reached the daily cap',
      recipientId: options.recipientId,
      teamId: options.teamId,
    });

    return { status: 'throttled' };
  }

  const segments = getSmsSegmentCount(options.body);

  if (segments > 1) {
    // Measured but not blocked: multi-segment costs more and risks carrier
    // truncation, and the usual cause is an unexpectedly long document title.
    logger.warn({
      msg: 'SMS body spans multiple segments',
      segments,
      length: options.body.length,
      teamId: options.teamId,
    });
  }

  const form = new URLSearchParams({
    To: options.to,
    From: options.from,
    Body: options.body,
  });

  if (options.statusCallbackUrl) {
    form.set('StatusCallback', options.statusCallbackUrl);
  }

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const payload = await response.json();

  if (!response.ok) {
    const error = new SmsSendError(payload?.message ?? 'Twilio rejected the message', {
      code: typeof payload?.code === 'number' ? payload.code : 0,
      status: response.status,
    });

    // A provider-side unsubscribe is authoritative. Record it so the next send
    // is skipped locally instead of billing another rejected request.
    if (error.code === TWILIO_OPT_OUT_ERROR_CODE && (options.suppressOnProviderOptOut ?? true)) {
      // Bookkeeping must never mask the send error. If this write fails, the
      // Twilio reason is still the useful thing to report.
      try {
        await suppressPhone({
          phone: options.to,
          teamId: options.teamId,
          reason: 'PROVIDER_PERMANENT',
        });
      } catch (suppressionError) {
        logger.warn({
          msg: 'Could not record a provider-side SMS opt-out',
          teamId: options.teamId,
          error: suppressionError,
        });
      }
    }

    throw error;
  }

  return { status: 'sent', providerMessageId: payload.sid };
};
