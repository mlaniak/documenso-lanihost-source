import {
  type DocumentNotificationSettingsForm,
  emptyDocumentNotificationSettings,
  NOTIFICATION_EVENTS,
} from '@documenso/lib/types/document-notification-settings';
import { Trans } from '@lingui/react/macro';

import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { Input } from '../../primitives/input';
import { Label } from '../../primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';

export type NotificationSettingsPickerProps = {
  value: DocumentNotificationSettingsForm | null;
  onChange: (value: DocumentNotificationSettingsForm | null) => void;
  canInherit?: boolean;
};

export const NotificationSettingsPicker = ({ value, onChange, canInherit }: NotificationSettingsPickerProps) => {
  const settings = value ?? emptyDocumentNotificationSettings();
  const update = (patch: Partial<DocumentNotificationSettingsForm>) => onChange({ ...settings, ...patch });
  const staff = settings.staff;
  return (
    <div className="space-y-5" data-testid="document-notification-settings">
      <Select
        value={value ? 'custom' : 'inherit'}
        onValueChange={(mode) => onChange(mode === 'inherit' ? null : emptyDocumentNotificationSettings())}
      >
        <SelectTrigger aria-label="Additional notification settings">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {canInherit ? <Trans>Inherit from organisation</Trans> : <Trans>Additional notifications off</Trans>}
          </SelectItem>
          <SelectItem value="custom">
            <Trans>Custom signer and staff notifications</Trans>
          </SelectItem>
        </SelectContent>
      </Select>
      {value && (
        <>
          <section className="space-y-4 rounded-md border border-border p-4" aria-label="Signer push notifications">
            <div>
              <h4 className="font-medium text-sm">
                <Trans>Recipients / signers</Trans>
              </h4>
              <p className="mt-1 text-muted-foreground text-xs">
                <Trans>
                  SMS uses the company Twilio account and sender above. ntfy is an additional, independent channel.
                </Trans>
              </p>
            </div>
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={settings.signers.ntfyEnabled}
                onCheckedChange={(checked) =>
                  update({ signers: { ...settings.signers, ntfyEnabled: checked === true } })
                }
              />
              <Trans>Send ntfy push to enrolled signers</Trans>
            </Label>
            {settings.signers.ntfyEnabled && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-xs">
                  <Trans>
                    Each person must subscribe to a private topic restricted to them. Push links open their
                    authenticated inbox; signing links remain in email.
                  </Trans>
                </p>
                {settings.signers.targets.map((target, index) => (
                  <div className="grid gap-2 rounded-md border p-3" key={index}>
                    <Label htmlFor={`ntfy-signer-email-${index}`}>
                      <Trans>Signer email</Trans>
                    </Label>
                    <Input
                      id={`ntfy-signer-email-${index}`}
                      type="email"
                      value={target.email}
                      onChange={(e) =>
                        update({
                          signers: {
                            ...settings.signers,
                            targets: settings.signers.targets.map((t, i) =>
                              i === index ? { ...t, email: e.target.value } : t,
                            ),
                          },
                        })
                      }
                    />
                    <Label htmlFor={`ntfy-signer-topic-${index}`}>
                      <Trans>Private topic</Trans>
                    </Label>
                    <Input
                      id={`ntfy-signer-topic-${index}`}
                      value={target.topic}
                      onChange={(e) =>
                        update({
                          signers: {
                            ...settings.signers,
                            targets: settings.signers.targets.map((t, i) =>
                              i === index ? { ...t, topic: e.target.value } : t,
                            ),
                          },
                        })
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        update({
                          signers: {
                            ...settings.signers,
                            targets: settings.signers.targets.filter((_, i) => i !== index),
                          },
                        })
                      }
                    >
                      <Trans>Remove signer subscription</Trans>
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={settings.signers.targets.length >= 100}
                  onClick={() =>
                    update({
                      signers: {
                        ...settings.signers,
                        targets: [...settings.signers.targets, { email: '', topic: '' }],
                      },
                    })
                  }
                >
                  <Trans>Add signer subscription</Trans>
                </Button>
              </div>
            )}
          </section>
          <section className="space-y-4 rounded-md border border-border p-4" aria-label="Internal staff notifications">
            <div>
              <h4 className="font-medium text-sm">
                <Trans>Me / internal staff</Trans>
              </h4>
              <p className="mt-1 text-muted-foreground text-xs">
                <Trans>
                  Short operational notices with a protected document link. Document titles, signer details and signing
                  links stay out of these alerts.
                </Trans>
              </p>
            </div>
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={staff.smsEnabled}
                onCheckedChange={(checked) => update({ staff: { ...staff, smsEnabled: checked === true } })}
              />
              <Trans>Send staff SMS using this company’s Twilio account</Trans>
            </Label>
            {staff.smsEnabled && (
              <div className="space-y-2">
                {staff.phones.map((phone, index) => (
                  <div className="flex gap-2" key={index}>
                    <Input
                      aria-label={`Staff mobile ${index + 1}`}
                      type="tel"
                      value={phone}
                      placeholder="+18325550101"
                      onChange={(e) =>
                        update({
                          staff: { ...staff, phones: staff.phones.map((p, i) => (i === index ? e.target.value : p)) },
                        })
                      }
                    />
                    <Button
                      aria-label={`Remove staff mobile ${index + 1}`}
                      type="button"
                      variant="outline"
                      onClick={() =>
                        update({ staff: { ...staff, phones: staff.phones.filter((_, i) => i !== index) } })
                      }
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={staff.phones.length >= 20}
                  onClick={() => update({ staff: { ...staff, phones: [...staff.phones, ''] } })}
                >
                  <Trans>Add authorised staff mobile</Trans>
                </Button>
                <p className="text-muted-foreground text-xs">
                  <Trans>
                    Use international format with + and country code. Enrol only people who agreed to receive these
                    texts. Carrier charges and opt-outs apply.
                  </Trans>
                </p>
              </div>
            )}
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={staff.ntfyEnabled}
                onCheckedChange={(checked) => update({ staff: { ...staff, ntfyEnabled: checked === true } })}
              />
              <Trans>Send ntfy push to me / staff</Trans>
            </Label>
            {staff.ntfyEnabled && (
              <div className="space-y-2">
                <Label htmlFor="staff-ntfy-topic">
                  <Trans>Private staff topic</Trans>
                </Label>
                <Input
                  id="staff-ntfy-topic"
                  value={staff.topic}
                  onChange={(e) => update({ staff: { ...staff, topic: e.target.value } })}
                />
                <p className="text-muted-foreground text-xs">
                  <Trans>
                    Grant read access only to the intended company staff. Keep this topic separate from all signer
                    topics.
                  </Trans>
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label>
                <Trans>Notify staff when</Trans>
              </Label>
              {NOTIFICATION_EVENTS.map((event) => (
                <Label className="flex items-center gap-2 font-normal" key={event}>
                  <Checkbox
                    checked={staff.events.includes(event)}
                    onCheckedChange={(checked) =>
                      update({
                        staff: {
                          ...staff,
                          events: checked ? [...staff.events, event] : staff.events.filter((e) => e !== event),
                        },
                      })
                    }
                  />
                  {event === 'DOCUMENT_SIGNED' ? (
                    <Trans>A recipient signs</Trans>
                  ) : (
                    <Trans>The document is fully completed</Trans>
                  )}
                </Label>
              ))}
            </div>
          </section>
          {(settings.signers.ntfyEnabled || staff.ntfyEnabled) && (
            <section className="space-y-3 rounded-md border border-border p-4" aria-label="Company ntfy connection">
              <h4 className="font-medium text-sm">
                <Trans>Company ntfy connection</Trans>
              </h4>
              <Label htmlFor="ntfy-server-url">
                <Trans>ntfy server</Trans>
              </Label>
              <Input
                id="ntfy-server-url"
                type="url"
                value={settings.ntfy.serverUrl}
                onChange={(e) => update({ ntfy: { ...settings.ntfy, serverUrl: e.target.value } })}
              />
              <Label htmlFor="ntfy-publisher-token">
                <Trans>Publisher token</Trans>
              </Label>
              <Input
                id="ntfy-publisher-token"
                type="password"
                autoComplete="off"
                value={settings.ntfy.newToken ?? ''}
                placeholder={settings.ntfy.hasToken ? '•••••••• (leave blank to keep)' : ''}
                onChange={(e) => update({ ntfy: { ...settings.ntfy, newToken: e.target.value } })}
              />
              <p className="text-muted-foreground text-xs">
                <Trans>
                  Use a publisher identity with write access only to this company’s intended topics. Tokens are
                  encrypted and never returned to the browser. Leave blank to keep the saved token.
                </Trans>
              </p>
              <p className="text-muted-foreground text-xs">
                <Trans>
                  ntfy delivers app/browser push, not ordinary SMS. A provider acceptance does not confirm phone or
                  desktop receipt.
                </Trans>
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
};
