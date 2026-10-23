import { z } from 'zod';

import { SMS_E164_PATTERN } from '../constants/sms-delivery';

export const NOTIFICATION_EVENTS = ['DOCUMENT_SIGNED', 'DOCUMENT_COMPLETED'] as const;
const topic = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Use letters, numbers, underscores or hyphens for a topic');
const events = z.array(z.enum(NOTIFICATION_EVENTS)).max(2);

export const ZDocumentNotificationSettingsSchema = z.object({
  ntfy: z.object({
    serverUrl: z.string().url().default('https://ntfy.lanihost.com'),
    token: z.string().optional(),
    hasToken: z.boolean().optional(),
  }),
  signers: z.object({
    ntfyEnabled: z.boolean(),
    targets: z
      .array(
        z.object({
          email: z
            .string()
            .trim()
            .email()
            .transform((v) => v.toLowerCase()),
          topic,
        }),
      )
      .max(100),
  }),
  staff: z.object({
    smsEnabled: z.boolean(),
    phones: z.array(z.string().regex(SMS_E164_PATTERN)).max(20),
    ntfyEnabled: z.boolean(),
    topic: z.string(),
    events,
  }),
});

export type DocumentNotificationSettings = z.infer<typeof ZDocumentNotificationSettingsSchema>;

export const ZDocumentNotificationSettingsFormSchema = ZDocumentNotificationSettingsSchema.extend({
  ntfy: ZDocumentNotificationSettingsSchema.shape.ntfy.omit({ token: true }).extend({
    newToken: z.string().optional(),
  }),
}).superRefine((value, ctx) => {
  const topics = value.signers.targets.map((target) => target.topic);
  const emails = value.signers.targets.map((target) => target.email);

  if (new Set(topics).size !== topics.length || new Set(emails).size !== emails.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Each signer needs a unique email and private topic',
      path: ['signers', 'targets'],
    });
  }

  if (value.staff.ntfyEnabled && (!topic.safeParse(value.staff.topic).success || topics.includes(value.staff.topic))) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use a valid staff topic separate from signer topics',
      path: ['staff', 'topic'],
    });
  }

  if (value.signers.ntfyEnabled && !value.signers.targets.length) {
    ctx.addIssue({ code: 'custom', message: 'Add an enrolled signer and private topic', path: ['signers', 'targets'] });
  }

  if ((value.staff.smsEnabled || value.staff.ntfyEnabled) && !value.staff.events.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Choose at least one staff notification event',
      path: ['staff', 'events'],
    });
  }

  if (value.staff.smsEnabled && !value.staff.phones.length) {
    ctx.addIssue({ code: 'custom', message: 'Add an authorised staff mobile number', path: ['staff', 'phones'] });
  }
});

export type DocumentNotificationSettingsForm = z.infer<typeof ZDocumentNotificationSettingsFormSchema>;

export const emptyDocumentNotificationSettings = (): DocumentNotificationSettingsForm => ({
  ntfy: { serverUrl: 'https://ntfy.lanihost.com', hasToken: false, newToken: '' },
  signers: { ntfyEnabled: false, targets: [] },
  staff: { smsEnabled: false, phones: [], ntfyEnabled: false, topic: '', events: ['DOCUMENT_COMPLETED'] },
});

export const parseDocumentNotificationSettings = (value: unknown): DocumentNotificationSettings => {
  const result = ZDocumentNotificationSettingsSchema.safeParse(value);
  return result.success ? result.data : ZDocumentNotificationSettingsSchema.parse(emptyDocumentNotificationSettings());
};

export const redactDocumentNotificationSettings = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const settings = value as Record<string, unknown>;
  const ntfy = settings.ntfy && typeof settings.ntfy === 'object' ? (settings.ntfy as Record<string, unknown>) : {};
  const { token, ...publicNtfy } = ntfy;
  return { ...settings, ntfy: { ...publicNtfy, hasToken: Boolean(token) } };
};

export const toDocumentNotificationSettingsForm = (value: unknown): DocumentNotificationSettingsForm | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = parseDocumentNotificationSettings(value);
  return {
    ...parsed,
    ntfy: { serverUrl: parsed.ntfy.serverUrl, hasToken: parsed.ntfy.hasToken ?? false, newToken: '' },
  };
};
