import type { TSmsSettingsForm } from '@documenso/lib/types/sms-settings-form';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@documenso/ui/primitives/select';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

type SmsMode = 'enabled' | 'disabled' | 'inherit';

const getMode = (value: TSmsSettingsForm | null | undefined): SmsMode => {
  if (value === null || value === undefined) {
    return 'inherit';
  }

  return value.enabled ? 'enabled' : 'disabled';
};

const EMPTY_SETTINGS: TSmsSettingsForm = {
  enabled: true,
  senderNumber: '',
  defaultOn: true,
  brandLabel: '',
  accountSid: '',
  // False, not undefined: seeding a brand-new configuration means we positively
  // know there is no token at this scope. Undefined is reserved for a value
  // that came from the server with the flag genuinely absent, where only the
  // server can answer. Blurring the two lets a first-time setup submit with no
  // token and receive a generic error instead of the inline one.
  hasAuthToken: false,
  newAuthToken: '',
};

export type SmsSettingsPickerProps = {
  value: TSmsSettingsForm | null | undefined;
  onChange: (value: TSmsSettingsForm | null) => void;
  disabled?: boolean;
  forceConnection?: boolean;
  onLoadSenders?: (draft: {
    accountSid?: string;
    newAuthToken?: string;
  }) => Promise<Array<{ phoneNumber: string; friendlyName: string }>>;
  inheritLabel?: string;
  /** Shown so the operator can paste it into this account's Twilio console. */
  inboundWebhookUrl?: string;
  /**
   * Sends one message to the supplied number using the saved settings. Absent
   * hides the control, since there is nothing useful to test against.
   */
  onSendTest?: (phone: string) => Promise<void>;
};

export const SmsSettingsPicker = ({
  value,
  onChange,
  disabled,
  forceConnection,
  onLoadSenders,
  inheritLabel,
  inboundWebhookUrl,
  onSendTest,
}: SmsSettingsPickerProps) => {
  const mode = value == null && !inheritLabel ? 'disabled' : getMode(value);
  const [senders, setSenders] = useState<Array<{ phoneNumber: string; friendlyName: string }>>([]);
  const [isLoadingSenders, setIsLoadingSenders] = useState(false);
  const [senderError, setSenderError] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);

  const handleSendTest = async () => {
    if (!onSendTest || !testPhone) {
      return;
    }

    setIsSendingTest(true);

    try {
      await onSendTest(testPhone);
    } finally {
      setIsSendingTest(false);
    }
  };

  const update = (patch: Partial<TSmsSettingsForm>) => {
    onChange({ ...EMPTY_SETTINGS, enabled: mode === 'enabled', defaultOn: mode === 'enabled', ...value, ...patch });
  };

  const onModeChange = (nextMode: SmsMode) => {
    if (nextMode === 'inherit') {
      onChange(null);
      return;
    }

    update({ enabled: nextMode === 'enabled' });
  };

  return (
    <div className="space-y-4">
      <Select value={mode} onValueChange={onModeChange} disabled={disabled}>
        <SelectTrigger className="bg-background text-muted-foreground">
          <SelectValue />
        </SelectTrigger>

        <SelectContent>
          {inheritLabel && <SelectItem value="inherit">{inheritLabel}</SelectItem>}
          <SelectItem value="enabled">
            <Trans>Send text messages</Trans>
          </SelectItem>
          <SelectItem value="disabled">
            <Trans>Do not send text messages</Trans>
          </SelectItem>
        </SelectContent>
      </Select>

      {(mode === 'enabled' || forceConnection) && (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div className="space-y-2">
            <Label>
              <Trans>Twilio account SID</Trans>
            </Label>

            <Input
              value={value?.accountSid ?? ''}
              onChange={(event) => update({ accountSid: event.target.value })}
              placeholder="AC..."
              disabled={disabled}
            />

            <p className="text-muted-foreground text-xs">
              <Trans>
                Each business has its own Twilio account. Use the credentials from the account that owns the sending
                number below.
              </Trans>
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              <Trans>Twilio auth token</Trans>
            </Label>

            <Input
              type="password"
              autoComplete="off"
              value={value?.newAuthToken ?? ''}
              onChange={(event) => update({ newAuthToken: event.target.value })}
              placeholder={value?.hasAuthToken ? '••••••••  (leave blank to keep)' : ''}
              disabled={disabled}
            />

            <p className="text-muted-foreground text-xs">
              {value?.hasAuthToken === true && (
                <Trans>A token is saved. Leave this blank to keep it, or enter a new one to replace it.</Trans>
              )}
              {value?.hasAuthToken === false && (
                <Trans>No token is saved yet. SMS cannot send until one is entered.</Trans>
              )}
              {value?.hasAuthToken === undefined && (
                <Trans>Leave blank to keep any saved token, or enter one to set or replace it.</Trans>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              <Trans>Sending number</Trans>
            </Label>

            <Input
              value={value?.senderNumber ?? ''}
              onChange={(event) => update({ senderNumber: event.target.value })}
              placeholder="+18325551234"
              disabled={disabled}
            />

            {onLoadSenders && (
              <div className="space-y-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled || isLoadingSenders}
                  onClick={async () => {
                    setIsLoadingSenders(true);
                    setSenderError('');
                    try {
                      setSenders(
                        await onLoadSenders({ accountSid: value?.accountSid, newAuthToken: value?.newAuthToken }),
                      );
                    } catch {
                      setSenderError('Could not load senders. Check the company account and token, then try again.');
                    } finally {
                      setIsLoadingSenders(false);
                    }
                  }}
                >
                  <Trans>Load this account’s sender numbers</Trans>
                </Button>
                {senders.length > 0 && (
                  <Select
                    value={value?.senderNumber || undefined}
                    onValueChange={(senderNumber) => update({ senderNumber })}
                  >
                    <SelectTrigger aria-label="Company Twilio sender">
                      <SelectValue placeholder="Choose a sender" />
                    </SelectTrigger>
                    <SelectContent>
                      {senders.map((sender) => (
                        <SelectItem key={sender.phoneNumber} value={sender.phoneNumber}>
                          {sender.phoneNumber} — {sender.friendlyName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {senderError && (
                  <p role="alert" className="text-destructive text-xs">
                    {senderError}
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  <Trans>
                    Uses the saved company credentials. Owning a number does not verify its registration or consent
                    eligibility.
                  </Trans>
                </p>
              </div>
            )}

            <p className="text-muted-foreground text-xs">
              <Trans>
                In E.164 format, starting with a plus and country code. The number must belong to the account above.
              </Trans>
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              <Trans>Brand name</Trans>
            </Label>

            <Input
              value={value?.brandLabel ?? ''}
              onChange={(event) => update({ brandLabel: event.target.value })}
              placeholder="EverTrade"
              maxLength={24}
              disabled={disabled}
            />

            <p className="text-muted-foreground text-xs">
              <Trans>Shown at the start of every message so the recipient knows who is texting them.</Trans>
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              <Trans>Text by default</Trans>
            </Label>

            <Select
              value={value?.defaultOn === false ? 'false' : 'true'}
              onValueChange={(next) => update({ defaultOn: next === 'true' })}
              disabled={disabled}
            >
              <SelectTrigger className="bg-background text-muted-foreground">
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                <SelectItem value="true">
                  <Trans>On for new documents</Trans>
                </SelectItem>
                <SelectItem value="false">
                  <Trans>Off unless turned on per document</Trans>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {onSendTest && (
            <div className="space-y-2">
              <Label>
                <Trans>Send a test message</Trans>
              </Label>

              <div className="flex gap-2">
                <Input
                  type="tel"
                  autoComplete="tel"
                  value={testPhone}
                  onChange={(event) => setTestPhone(event.target.value)}
                  placeholder="+18325551234"
                  disabled={disabled || isSendingTest}
                />

                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleSendTest}
                  disabled={disabled || isSendingTest || testPhone.trim() === ''}
                  loading={isSendingTest}
                >
                  <Trans>Send test</Trans>
                </Button>
              </div>

              <p className="text-muted-foreground text-xs">
                <Trans>
                  Sends one real message using the saved settings, so a wrong credential or number shows up here rather
                  than as a document notification that never arrives. Save your changes first.
                </Trans>
              </p>
            </div>
          )}

          {inboundWebhookUrl && (
            <div className="space-y-2">
              <Label>
                <Trans>Incoming message webhook</Trans>
              </Label>

              <Input value={inboundWebhookUrl} readOnly onFocus={(event) => event.target.select()} />

              <p className="text-muted-foreground text-xs">
                <Trans>
                  Use this only for a dedicated document sender or an explicitly configured forwarding path. Preserve
                  any existing SMS inbox and opt-out handler; do not replace a live conversation webhook.
                </Trans>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
