import { symmetricDecrypt, symmetricEncrypt } from '@documenso/lib/universal/crypto';

import { DOCUMENSO_ENCRYPTION_SECONDARY_KEY } from '../../constants/crypto';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { parseSmsSettings } from '../../types/sms-settings';
import { env } from '../../utils/env';
import { getTeamSettings } from '../team/get-team-settings';

export type SmsCredentials = {
  accountSid: string;
  authToken: string;
};

/**
 * Mirrors how email transport secrets are stored: encrypted at rest with the
 * secondary key, never returned to a client, decrypted only at send time.
 */
export const encryptSmsAuthToken = (authToken: string): string => {
  if (!DOCUMENSO_ENCRYPTION_SECONDARY_KEY) {
    throw new Error('Missing encryption key');
  }

  return symmetricEncrypt({ key: DOCUMENSO_ENCRYPTION_SECONDARY_KEY, data: authToken });
};

export const decryptSmsAuthToken = (encrypted: string): string => {
  if (!DOCUMENSO_ENCRYPTION_SECONDARY_KEY) {
    throw new Error('Missing encryption key');
  }

  return Buffer.from(symmetricDecrypt({ key: DOCUMENSO_ENCRYPTION_SECONDARY_KEY, data: encrypted })).toString('utf-8');
};

/**
 * Each business verifies its own Twilio account, so credentials are per team
 * rather than global. A number belongs to exactly one account, which is why a
 * team SID is never paired with an environment token: that combination is
 * guaranteed to be rejected by Twilio, and failing here is clearer than
 * failing at the API.
 *
 * Environment credentials remain the fallback so a single-account self-host
 * keeps working without touching the database.
 */
export const resolveSmsCredentials = (settings: { accountSid?: string; authToken?: string }): SmsCredentials | null => {
  if (settings.accountSid && settings.authToken) {
    try {
      return { accountSid: settings.accountSid, authToken: decryptSmsAuthToken(settings.authToken) };
    } catch {
      // A token that cannot be decrypted means the encryption key changed.
      // Refusing to send is correct: the alternative is silently falling back
      // to another account's credentials.
      return null;
    }
  }

  if (settings.accountSid || settings.authToken) {
    return null;
  }

  const accountSid = env('TWILIO_ACCOUNT_SID');
  const authToken = env('TWILIO_AUTH_TOKEN');

  if (!accountSid || !authToken) {
    return null;
  }

  return { accountSid, authToken };
};

/**
 * Credentials for a team, or null when it is not configured or cannot be read.
 * Both Twilio webhooks resolve their verification key this way, keyed by the
 * team id in the request URL.
 */
export const getTeamSmsCredentials = async (teamId: number): Promise<SmsCredentials | null> => {
  try {
    const teamSettings = await getTeamSettings({ teamId });

    return resolveSmsCredentials(parseSmsSettings(teamSettings.smsSettings));
  } catch {
    return null;
  }
};

/**
 * Merge a settings form submission with what is already stored.
 *
 * A blank `newAuthToken` means "keep the existing token": the browser never
 * receives the stored one, so it cannot echo it back, and treating blank as
 * "clear it" would silently disable SMS every time an unrelated setting was
 * saved.
 */
export const mergeSmsSettingsForStorage = (options: {
  submitted: {
    enabled: boolean;
    senderNumber: string;
    defaultOn: boolean;
    brandLabel: string;
    accountSid: string;
    newAuthToken?: string;
  };
  stored: unknown;
}): Record<string, unknown> => {
  const storedRecord =
    options.stored && typeof options.stored === 'object' ? (options.stored as Record<string, unknown>) : {};

  const existingAuthToken = typeof storedRecord.authToken === 'string' ? storedRecord.authToken : undefined;

  const authToken = options.submitted.newAuthToken
    ? encryptSmsAuthToken(options.submitted.newAuthToken)
    : existingAuthToken;

  // Enabled with no token could never send, so refuse rather than store a
  // configuration that fails silently at delivery time. Checked here because
  // only the server can see whether a token is already stored.
  if (options.submitted.enabled && !authToken) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'A Twilio auth token is required before SMS can be enabled',
      statusCode: 400,
    });
  }

  return {
    enabled: options.submitted.enabled,
    senderNumber: options.submitted.senderNumber,
    defaultOn: options.submitted.defaultOn,
    brandLabel: options.submitted.brandLabel,
    accountSid: options.submitted.accountSid,
    ...(authToken ? { authToken } : {}),
  };
};
