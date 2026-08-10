import { prisma } from '@documenso/prisma';

import { isTwilioOptOutError, normalisePhoneNumber, SmsSendError } from '../../constants/sms-delivery';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { parseSmsSettings } from '../../types/sms-settings';
import { sendSms } from './send-sms';
import { resolveSmsCredentials } from './sms-credentials';

export type SendTestSmsOptions = {
  organisationId: string;
  phone: string;
};

export type SendTestSmsResult = {
  providerMessageId: string;
  to: string;
};

/**
 * Send one message to a number the operator supplies, to prove the whole chain
 * works before anyone builds a document around it.
 *
 * The value here is the error surface: a misconfiguration otherwise shows up as
 * a text that silently never arrives, which is the single hardest failure to
 * diagnose in this feature. Twilio's own error code and message are passed
 * back verbatim so the settings page can say what is actually wrong.
 */
export const sendTestSms = async (options: SendTestSmsOptions): Promise<SendTestSmsResult> => {
  const to = normalisePhoneNumber(options.phone);

  if (!to) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Enter a mobile number in E.164 format, for example +18325551234',
      statusCode: 400,
    });
  }

  const organisation = await prisma.organisation.findUniqueOrThrow({
    where: { id: options.organisationId },
    include: { organisationGlobalSettings: true, teams: { select: { id: true } } },
  });

  const settings = parseSmsSettings(organisation.organisationGlobalSettings.smsSettings);

  if (!settings.enabled) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Enable SMS and save before sending a test message',
      statusCode: 400,
    });
  }

  const credentials = resolveSmsCredentials(settings);

  if (!credentials) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'No usable Twilio credentials are saved for this organisation',
      statusCode: 400,
    });
  }

  // Suppression is per team, and a test has no team of its own, so honour an
  // opt-out recorded against any team in this organisation. Texting someone who
  // replied STOP would be a compliance problem, test or not.
  const teamIds = organisation.teams.map((team) => team.id);

  const suppression =
    teamIds.length > 0
      ? await prisma.smsOptOut.findFirst({ where: { phone: to, teamId: { in: teamIds } }, select: { id: true } })
      : null;

  if (suppression) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'That number has opted out of messages from this organisation',
      statusCode: 400,
    });
  }

  const body = `${settings.brandLabel}: test message. SMS is configured correctly. Reply STOP to opt out.`;

  try {
    // teamId 0 is a sentinel: suppression was already checked organisation-wide
    // above, and no recipientId keeps the per-recipient daily cap out of a
    // diagnostic that may be run several times in a row.
    //
    // suppressOnProviderOptOut is off because there is no real team to attribute
    // a suppression to, and writing one against the sentinel violates the
    // SmsOptOut foreign key. That failure would surface as a database error in
    // place of Twilio's reason, which is the one thing this control exists to
    // show.
    const result = await sendSms({
      to,
      from: settings.senderNumber,
      body,
      teamId: 0,
      credentials,
      suppressOnProviderOptOut: false,
    });

    if (result.status !== 'sent') {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `The message was not sent (${result.status})`,
        statusCode: 400,
      });
    }

    return { providerMessageId: result.providerMessageId, to };
  } catch (error) {
    if (error instanceof SmsSendError) {
      // Twilio's own wording is far more useful than anything generic: it names
      // a bad credential, an unowned number, or an unreachable handset.
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: isTwilioOptOutError(error)
          ? 'Twilio reports that number has opted out of messages from this sender'
          : `Twilio rejected the message (${error.code}): ${error.message}`,
        statusCode: 400,
      });
    }

    throw error;
  }
};
