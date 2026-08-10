import { z } from 'zod';

import { SMS_E164_PATTERN } from '../constants/sms-delivery';

/**
 * Secret keys, kept in sync with the omission in ZPublicSmsSettingsSchema.
 * Mirrors EMAIL_TRANSPORT_SECRET_KEYS in the email transport config.
 */
export const SMS_SETTINGS_SECRET_KEYS = ['authToken'] as const;

export const ZSmsSettingsSchema = z.object({
  enabled: z.boolean(),
  senderNumber: z.string().regex(SMS_E164_PATTERN, 'Sender number must be in E.164 format'),
  defaultOn: z.boolean(),
  brandLabel: z.string().min(1).max(24),
  /**
   * Each business verifies its own Twilio account, so credentials belong beside
   * the number they authorise. Absent means fall back to the environment.
   */
  accountSid: z.string().min(1).optional(),
  /** Encrypted at rest. Secret — keep in sync with SMS_SETTINGS_SECRET_KEYS. */
  authToken: z.string().min(1).optional(),
  /**
   * Transport-only flag saying a token exists, set by redactSmsSettings on the
   * way out. Declared here because tRPC response schemas validate this shape
   * with the generated Prisma schema, and Zod silently strips unknown keys —
   * which previously made the settings form believe no token was stored.
   * mergeSmsSettingsForStorage never writes it back.
   */
  hasAuthToken: z.boolean().optional(),
});

export type TSmsSettings = z.infer<typeof ZSmsSettingsSchema>;

/**
 * The shape safe to send to a browser. The auth token never leaves the server,
 * so the UI shows whether credentials are configured, never their value.
 */
export const ZPublicSmsSettingsSchema = ZSmsSettingsSchema.omit({ authToken: true }).extend({
  hasAuthToken: z.boolean(),
});

export type TPublicSmsSettings = z.infer<typeof ZPublicSmsSettingsSchema>;

export const toPublicSmsSettings = (settings: TSmsSettings): TPublicSmsSettings => {
  const { authToken, ...rest } = settings;

  return { ...rest, hasAuthToken: Boolean(authToken) };
};

export const SMS_SETTINGS_DISABLED: TSmsSettings = {
  enabled: false,
  senderNumber: '+10000000000',
  defaultOn: false,
  brandLabel: 'Documenso',
};

/**
 * `getTeamSettings` already merges organisation and team values through
 * `extractDerivedTeamSettings`, so this only has to fail closed on anything
 * unparseable rather than reimplement inheritance.
 */
export const parseSmsSettings = (value: unknown): TSmsSettings => {
  const parsed = ZSmsSettingsSchema.safeParse(value);

  return parsed.success ? parsed.data : SMS_SETTINGS_DISABLED;
};

/**
 * Strip the auth token from a settings row before it crosses to a client.
 *
 * The token is encrypted at rest, but ciphertext still does not belong in a
 * browser: any organisation member could read it from a network response and
 * attack it offline. Apply this at every tRPC boundary that returns a
 * *GlobalSettings row, mirroring how the email transport config omits its
 * secrets.
 */
export const redactSmsSettings = <T extends { smsSettings: unknown } | null>(settings: T): T => {
  if (!settings || typeof settings.smsSettings !== 'object' || settings.smsSettings === null) {
    return settings;
  }

  const { authToken, ...rest } = settings.smsSettings as Record<string, unknown>;

  return {
    ...settings,
    smsSettings: { ...rest, hasAuthToken: Boolean(authToken) },
  };
};
