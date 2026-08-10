import type { ScheduledReminderProviderStatus } from '@prisma/client';

export const SMS_E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Converts loosely formatted input into E.164, or null when the value cannot be
 * a valid mobile number. Null means "skip this recipient", never "throw".
 */
export const normalisePhoneNumber = (value: string, defaultCountryCode = '1'): string | null => {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  const hasCountryPrefix = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (digits === '') {
    return null;
  }

  const candidate = hasCountryPrefix || digits.length > 10 ? `+${digits}` : `+${defaultCountryCode}${digits}`;

  return SMS_E164_PATTERN.test(candidate) ? candidate : null;
};

/**
 * Twilio error codes that will never succeed on retry. Anything absent from
 * this set is treated as transient, because wasting five attempts is cheaper
 * than silently dropping a deliverable message.
 */
export const TWILIO_TERMINAL_ERROR_CODES = new Set([
  21211, // Invalid 'To' number
  21408, // Permission to send to this region is not enabled
  21610, // Recipient has unsubscribed
  21612, // Number is unroutable
  21614, // 'To' number is not a valid mobile number
  30003, // Unreachable destination handset
  30005, // Unknown destination handset
  30006, // Landline or unreachable carrier
]);

export const TWILIO_OPT_OUT_ERROR_CODE = 21610;

export class SmsSendError extends Error {
  public readonly code: number;
  public readonly status: number;

  constructor(message: string, options: { code: number; status: number }) {
    super(message);
    this.name = 'SmsSendError';
    this.code = options.code;
    this.status = options.status;
  }
}

export const isTwilioErrorTerminal = (error: unknown): boolean =>
  error instanceof SmsSendError && TWILIO_TERMINAL_ERROR_CODES.has(error.code);

export const isTwilioOptOutError = (error: unknown): boolean =>
  error instanceof SmsSendError && error.code === TWILIO_OPT_OUT_ERROR_CODE;

const GSM7_CHARACTERS =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const GSM7_EXTENDED_CHARACTERS = '^{}[~]|€';

/**
 * Every user-visible SMS string, injectable so the trigger layer can supply a
 * Lingui-translated set once the recipient locale is known. The default is
 * English. The builders stay pure so they remain unit-testable: the Lingui
 * macro is not transformed under vitest, so `msg` cannot live in this file.
 */
export type SmsCopy = {
  optOutNotice: string;
  signingRequest: (options: { brandLabel: string; signingUrl: string }) => string;
  completion: (options: { brandLabel: string; documentTitle: string }) => string;
  helpReply: string;
};

export const DEFAULT_SMS_COPY: SmsCopy = {
  optOutNotice: 'Reply STOP to opt out.',
  signingRequest: ({ brandLabel, signingUrl }) => `${brandLabel}: you have a document to sign. ${signingUrl}`,
  completion: ({ brandLabel, documentTitle }) =>
    `${brandLabel}: "${documentTitle}" is fully signed. The completed copy is in your email.`,
  helpReply:
    'This number sends document signing links. Reply STOP to opt out. For help, contact the sender named in your document email.',
};

const isGsm7 = (body: string): boolean =>
  [...body].every((character) => GSM7_CHARACTERS.includes(character) || GSM7_EXTENDED_CHARACTERS.includes(character));

/**
 * Segment count drives cost and truncation risk. GSM-7 fits 160 characters in
 * one segment and 153 per segment once concatenated; UCS-2 fits 70 and 67.
 */
export const getSmsSegmentCount = (body: string): number => {
  const length = [...body].length;

  if (length === 0) {
    return 0;
  }

  const single = isGsm7(body) ? 160 : 70;
  const concatenated = isGsm7(body) ? 153 : 67;

  return length <= single ? 1 : Math.ceil(length / concatenated);
};

export type SigningRequestSmsOptions = {
  brandLabel: string;
  signingUrl: string;
  includeOptOutNotice: boolean;
  copy?: SmsCopy;
};

export type CompletionSmsOptions = {
  brandLabel: string;
  documentTitle: string;
  includeOptOutNotice: boolean;
  copy?: SmsCopy;
};

const withOptOutNotice = (body: string, includeOptOutNotice: boolean, copy: SmsCopy): string =>
  includeOptOutNotice ? `${body} ${copy.optOutNotice}` : body;

export const buildSigningRequestSms = (options: SigningRequestSmsOptions): string => {
  const copy = options.copy ?? DEFAULT_SMS_COPY;

  return withOptOutNotice(
    copy.signingRequest({ brandLabel: options.brandLabel, signingUrl: options.signingUrl }),
    options.includeOptOutNotice,
    copy,
  );
};

export const buildCompletionSms = (options: CompletionSmsOptions): string => {
  const copy = options.copy ?? DEFAULT_SMS_COPY;

  return withOptOutNotice(
    copy.completion({ brandLabel: options.brandLabel, documentTitle: options.documentTitle }),
    options.includeOptOutNotice,
    copy,
  );
};

export type SmsKeyword = 'STOP' | 'START' | 'HELP' | 'OTHER';

const SMS_STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const SMS_START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);
const SMS_HELP_KEYWORDS = new Set(['HELP', 'INFO']);

/**
 * Only a whole-message keyword counts. Twilio's carrier-level opt-out uses the
 * same rule, so loosening this would desynchronise our suppression list from
 * the state Twilio actually enforces.
 */
export const classifySmsKeyword = (body: string): SmsKeyword => {
  const keyword = body.trim().toUpperCase();

  if (SMS_STOP_KEYWORDS.has(keyword)) {
    return 'STOP';
  }

  if (SMS_START_KEYWORDS.has(keyword)) {
    return 'START';
  }

  if (SMS_HELP_KEYWORDS.has(keyword)) {
    return 'HELP';
  }

  return 'OTHER';
};

const TWILIO_STATUS_MAP: Record<string, ScheduledReminderProviderStatus> = {
  queued: 'SUBMITTED',
  accepted: 'SUBMITTED',
  scheduled: 'SUBMITTED',
  sending: 'SUBMITTED',
  sent: 'SUBMITTED',
  delivered: 'DELIVERED',
  undelivered: 'BOUNCED',
  failed: 'FAILED',
};

/**
 * Null means a status we deliberately ignore rather than an unknown error, so
 * callers acknowledge the webhook instead of making Twilio retry it.
 */
export const mapTwilioMessageStatus = (status: string): ScheduledReminderProviderStatus | null =>
  TWILIO_STATUS_MAP[status.trim().toLowerCase()] ?? null;
