import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  type DocumentNotificationSettingsForm,
  parseDocumentNotificationSettings,
} from '../../types/document-notification-settings';
import { parseSmsSettings } from '../../types/sms-settings';
import { env } from '../../utils/env';
import { encryptSmsAuthToken, resolveSmsCredentials } from '../sms/sms-credentials';

/** Only operator-approved HTTPS origins may receive publisher credentials. */
export const getNtfyOrigin = (serverUrl: string): string => {
  const url = new URL(serverUrl);
  const allowed = (env('NEXT_PRIVATE_NTFY_ALLOWED_ORIGINS') || 'https://ntfy.lanihost.com')
    .split(',')
    .map((v) => v.trim());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !allowed.includes(url.origin)
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Use an HTTPS ntfy origin approved by the server operator',
    });
  }
  return url.origin;
};

export const mergeDocumentNotificationSettings = (submitted: DocumentNotificationSettingsForm, stored: unknown) => {
  const previous = parseDocumentNotificationSettings(stored);
  const pushEnabled = submitted.signers.ntfyEnabled || submitted.staff.ntfyEnabled;
  const submittedOrigin = submitted.ntfy.serverUrl.replace(/\/$/, '');
  const previousOrigin = previous.ntfy.serverUrl.replace(/\/$/, '');
  // An unused, unchanged default must not block independent staff SMS settings
  // on installations whose approved ntfy origin differs from that default.
  const configuringConnection = Boolean(submitted.ntfy.newToken) || submittedOrigin !== previousOrigin;
  const origin = pushEnabled || configuringConnection ? getNtfyOrigin(submitted.ntfy.serverUrl) : previousOrigin;
  if (previous.ntfy.token && origin !== previous.ntfy.serverUrl.replace(/\/$/, '') && !submitted.ntfy.newToken) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Enter a new publisher token when changing ntfy servers',
    });
  }
  const token = submitted.ntfy.newToken ? encryptSmsAuthToken(submitted.ntfy.newToken) : previous.ntfy.token;
  if (pushEnabled && !token) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Save an ntfy publisher token before enabling push notifications',
    });
  }
  return { ...submitted, ntfy: { serverUrl: origin, ...(token ? { token } : {}) } };
};

export const assertStaffSmsConnection = (notificationSettings: unknown, smsSettings: unknown) => {
  if (!parseDocumentNotificationSettings(notificationSettings).staff.smsEnabled) {
    return;
  }
  const sms = parseSmsSettings(smsSettings);
  // Staff SMS never borrows a global or another company's account.
  if (!sms.accountSid || !sms.authToken || !resolveSmsCredentials(sms) || sms.senderNumber === '+10000000000') {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Configure this company’s Twilio account, token and sender before enabling staff SMS',
    });
  }
};
