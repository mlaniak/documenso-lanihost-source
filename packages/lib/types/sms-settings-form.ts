import { z } from 'zod';

import { SMS_E164_PATTERN } from '../constants/sms-delivery';

/**
 * The shape the settings form exchanges with the server.
 *
 * It differs from the stored shape in two ways, both because the auth token is
 * a secret: the stored token is never sent to the browser (`hasAuthToken` says
 * only whether one exists), and a new token travels in its own field where
 * blank means "leave the stored one alone".
 */
export const ZSmsSettingsFormSchema = z.object({
  enabled: z.boolean(),
  senderNumber: z.string().regex(SMS_E164_PATTERN, 'Sender number must be in E.164 format'),
  defaultOn: z.boolean(),
  brandLabel: z.string().min(1).max(24),
  accountSid: z.string().min(1),
  /**
   * Tri-state on purpose. true/false is what the server reported; undefined
   * means we could not tell, and an unknown must never be treated as "no
   * token" — that is precisely what locked the form before.
   */
  hasAuthToken: z.boolean().optional(),
  /** Blank leaves the stored token unchanged. */
  newAuthToken: z.string().optional(),
});

export type TSmsSettingsForm = z.infer<typeof ZSmsSettingsFormSchema>;

/**
 * Block only when the server positively said there is no stored token and none
 * was entered. An unknown flag defers to the server, which validates this too.
 *
 * The earlier version collapsed unknown into false and locked every edit that
 * did not re-enter the token. Dropping the check entirely then traded that for
 * a generic "something went wrong" on the one case worth explaining.
 */
export const ZSmsSettingsFormValueSchema = ZSmsSettingsFormSchema.nullable().refine(
  (value) => !value || !value.enabled || value.hasAuthToken !== false || Boolean(value.newAuthToken),
  { message: 'Enter the Twilio auth token before enabling SMS' },
);

/**
 * Convert a stored (already redacted) settings value into the form shape.
 *
 * Returns null when nothing is configured, which the form renders as "inherit
 * from organisation" at team level and "not configured" at organisation level.
 */
export const toSmsSettingsFormValue = (value: unknown): TSmsSettingsForm | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const stored = value as Record<string, unknown>;

  return {
    enabled: stored.enabled === true,
    senderNumber: typeof stored.senderNumber === 'string' ? stored.senderNumber : '',
    defaultOn: stored.defaultOn !== false,
    brandLabel: typeof stored.brandLabel === 'string' ? stored.brandLabel : '',
    accountSid: typeof stored.accountSid === 'string' ? stored.accountSid : '',
    // Preserved as tri-state: a missing flag is "unknown", not "no token".
    hasAuthToken: typeof stored.hasAuthToken === 'boolean' ? stored.hasAuthToken : undefined,
    newAuthToken: '',
  };
};
