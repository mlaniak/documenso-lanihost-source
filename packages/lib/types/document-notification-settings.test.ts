import { describe, expect, it } from 'vitest';

import {
  emptyDocumentNotificationSettings,
  parseDocumentNotificationSettings,
  ZDocumentNotificationSettingsFormSchema,
} from './document-notification-settings';
import { redactSmsSettings } from './sms-settings';

describe('document notification settings', () => {
  it('defaults new notification routes off without changing legacy SMS', () => {
    const settings = parseDocumentNotificationSettings(null);
    expect(settings.staff.smsEnabled).toBe(false);
    expect(settings.staff.ntfyEnabled).toBe(false);
    expect(settings.signers.ntfyEnabled).toBe(false);
  });
  it('requires separate private signer topics and normalises email identities', () => {
    const settings = emptyDocumentNotificationSettings();
    settings.signers.targets = [
      { email: 'Person@Example.com', topic: 'private-one' },
      { email: 'other@example.com', topic: 'private-one' },
    ];
    expect(ZDocumentNotificationSettingsFormSchema.safeParse(settings).success).toBe(false);
    settings.signers.targets.pop();
    settings.staff.ntfyEnabled = true;
    settings.staff.topic = 'private-one';
    expect(ZDocumentNotificationSettingsFormSchema.safeParse(settings).success).toBe(false);
    settings.staff.topic = 'private-staff';
    expect(ZDocumentNotificationSettingsFormSchema.parse(settings).signers.targets[0].email).toBe('person@example.com');
  });
  it('requires enrolled targets for enabled channels', () => {
    const settings = emptyDocumentNotificationSettings();
    settings.signers.ntfyEnabled = true;
    settings.staff.smsEnabled = true;
    expect(ZDocumentNotificationSettingsFormSchema.safeParse(settings).success).toBe(false);
  });
  it('removes publisher tokens even when no SMS settings exist', () => {
    const settings = emptyDocumentNotificationSettings();
    const result = redactSmsSettings({
      smsSettings: null,
      notificationSettings: { ...settings, ntfy: { ...settings.ntfy, token: 'ENCRYPTED_SECRET' } },
    });
    expect(JSON.stringify(result)).not.toContain('ENCRYPTED_SECRET');
    expect(result.notificationSettings).toMatchObject({ ntfy: { hasToken: true } });
  });
});
