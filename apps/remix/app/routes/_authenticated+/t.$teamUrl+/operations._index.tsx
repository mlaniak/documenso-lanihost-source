import { trpc } from '@documenso/trpc/react';
import type { TFindOperationsOverviewResponse } from '@documenso/trpc/server/envelope-router/find-operations-overview.types';
import { Alert, AlertDescription, AlertTitle } from '@documenso/ui/primitives/alert';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@documenso/ui/primitives/card';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { Switch } from '@documenso/ui/primitives/switch';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangleIcon,
  ArchiveIcon,
  BarChart3Icon,
  BellRingIcon,
  CheckCircle2Icon,
  Clock3Icon,
  FileCheck2Icon,
  FileStackIcon,
  LinkIcon,
  MessageSquareTextIcon,
  Settings2Icon,
  ShieldCheckIcon,
  WebhookIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { TemplateUseDialog } from '~/components/dialogs/template-use-dialog';
import { useCurrentTeam } from '~/providers/team';
import { appMetaTags } from '~/utils/meta';

type Overview = TFindOperationsOverviewResponse;
type ActionItem = Overview['actionItems'][number];

export function meta() {
  return appMetaTags(msg`Operations`);
}

export default function OperationsPage() {
  const overview = trpc.envelope.operations.overview.useQuery(
    { windowDays: 90 },
    { refetchInterval: 60_000, refetchIntervalInBackground: false },
  );

  if (overview.isLoading || !overview.data) {
    return <OperationsLoadingState />;
  }

  return <OperationsContent data={overview.data} />;
}

const OperationsContent = ({ data }: { data: Overview }) => {
  const team = useCurrentTeam();
  const { t } = useLingui();
  const [smsRecipient, setSmsRecipient] = useState<ActionItem | null>(null);

  const metrics = [
    { label: t`Documents (90 days)`, value: data.metrics.total, icon: FileStackIcon },
    { label: t`Completed`, value: data.metrics.completed, icon: FileCheck2Icon },
    { label: t`Completion rate`, value: `${data.metrics.completionRate.toFixed(0)}%`, icon: BarChart3Icon },
    {
      label: t`Average turnaround`,
      value: data.metrics.averageTurnaroundHours === null ? '—' : formatDuration(data.metrics.averageTurnaroundHours),
      icon: Clock3Icon,
    },
    { label: t`Needs attention`, value: data.metrics.needsAttention, icon: AlertTriangleIcon },
  ];

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-10 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="font-semibold text-4xl">
            <Trans>Document operations</Trans>
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            <Trans>Launch repeatable workflows, resolve signing delays, and monitor completion automation.</Trans>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to={`/t/${team.url}/reminders`}>
              <BellRingIcon className="mr-2 h-4 w-4" />
              <Trans>Reminder delivery</Trans>
            </Link>
          </Button>
          <Button asChild>
            <Link to={`/t/${team.url}/templates`}>
              <FileStackIcon className="mr-2 h-4 w-4" />
              <Trans>Manage templates</Trans>
            </Link>
          </Button>
        </div>
      </div>

      <section aria-labelledby="operations-health-heading">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 id="operations-health-heading" className="font-semibold text-2xl">
              <Trans>90-day health</Trans>
            </h2>
            <p className="text-muted-foreground text-sm">
              <Trans>Live document throughput and signing performance.</Trans>
            </p>
          </div>
          <Badge variant={data.metrics.needsAttention ? 'warning' : 'default'}>
            {data.metrics.pending} <Trans>pending</Trans>
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {metrics.map((metric) => (
            <Card key={metric.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardDescription>{metric.label}</CardDescription>
                <metric.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="font-semibold text-3xl tabular-nums">{metric.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>
                  <Trans>Action needed</Trans>
                </CardTitle>
                <CardDescription>
                  <Trans>Recipients most likely to need intervention, ordered by age.</Trans>
                </CardDescription>
              </div>
              <Badge variant={data.actionItems.length ? 'warning' : 'default'}>{data.actionItems.length}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {data.actionItems.length === 0 ? (
              <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed text-center">
                <CheckCircle2Icon className="mb-3 h-8 w-8 text-green-500" />
                <p className="font-medium">
                  <Trans>No documents need intervention</Trans>
                </p>
                <p className="text-muted-foreground text-sm">
                  <Trans>Opened, overdue, and failed deliveries will appear here automatically.</Trans>
                </p>
              </div>
            ) : (
              <div className="divide-y rounded-lg border">
                {data.actionItems.slice(0, 12).map((item) => (
                  <div
                    key={`${item.envelopeId}-${item.recipientId}`}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          className="truncate font-medium hover:underline"
                          to={`/t/${team.url}/documents/${item.envelopeId}`}
                        >
                          {item.documentTitle}
                        </Link>
                        <ReasonBadge reason={item.reason} />
                      </div>
                      <p className="truncate text-muted-foreground text-sm">
                        {item.recipientName || item.recipientEmail} · {item.recipientEmail}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {item.ageDays} {item.ageDays === 1 ? t`day` : t`days`} <Trans>since sent</Trans>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/t/${team.url}/documents/${item.envelopeId}`}>
                          <Trans>Open</Trans>
                        </Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!data.integrations.smsProviderConfigured || !data.settings.smsEnabled}
                        onClick={() => setSmsRecipient(item)}
                      >
                        <MessageSquareTextIcon className="mr-2 h-4 w-4" />
                        <Trans>Text link</Trans>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <Trans>Monthly flow</Trans>
            </CardTitle>
            <CardDescription>
              <Trans>Documents created and completed during this window.</Trans>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.trend.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                <Trans>No activity in this period.</Trans>
              </p>
            ) : (
              data.trend.map((row) => {
                const max = Math.max(row.sent, row.completed, 1);
                return (
                  <div key={row.month}>
                    <div className="mb-2 flex justify-between text-sm">
                      <span className="font-medium">{formatMonth(row.month)}</span>
                      <span className="text-muted-foreground">
                        {row.completed}/{row.sent} <Trans>completed</Trans>
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-green-500"
                        style={{ width: `${(row.completed / max) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="font-semibold text-2xl">
            <Trans>Workflow launchers</Trans>
          </h2>
          <p className="text-muted-foreground text-sm">
            <Trans>Your most recently maintained templates become reusable one-click starting points.</Trans>
          </p>
        </div>
        {data.workflowPresets.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.workflowPresets.map((preset) => (
              <Card key={preset.envelopeId}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="line-clamp-2 text-lg">{preset.title}</CardTitle>
                      <CardDescription>
                        {preset.recipients.length} {preset.recipients.length === 1 ? t`recipient` : t`recipients`}
                      </CardDescription>
                    </div>
                    <FileCheck2Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent className="flex gap-2">
                  <TemplateUseDialog
                    envelopeId={preset.envelopeId}
                    templateId={preset.templateId}
                    templateSigningOrder={preset.signingOrder}
                    recipients={preset.recipients}
                    documentDistributionMethod={preset.distributionMethod}
                    documentRootPath={`/t/${team.url}/documents`}
                    trigger={
                      <Button size="sm">
                        <Trans>Start workflow</Trans>
                      </Button>
                    }
                  />
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/t/${team.url}/templates/${preset.envelopeId}`}>
                      <Trans>Review</Trans>
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Alert>
            <FileStackIcon className="h-4 w-4" />
            <AlertTitle>
              <Trans>Create your first reusable workflow</Trans>
            </AlertTitle>
            <AlertDescription>
              <Trans>Save a document as a template, then it will appear here as a launchable preset.</Trans>{' '}
              <Link className="underline" to={`/t/${team.url}/templates`}>
                <Trans>Open templates</Trans>
              </Link>
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <IntegrationHealth data={data} teamUrl={team.url} />
        <OperationsSettingsForm key={JSON.stringify(data.settings)} data={data} />
      </section>

      <section>
        <h2 className="mb-4 font-semibold text-2xl">
          <Trans>Built-in value checklist</Trans>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: t`Branding and email`, href: `/t/${team.url}/settings/branding`, icon: Settings2Icon },
            { label: t`Lifecycle webhooks`, href: `/t/${team.url}/settings/webhooks`, icon: WebhookIcon },
            { label: t`API and embedded signing`, href: `/t/${team.url}/settings/tokens`, icon: LinkIcon },
            {
              label: t`Security and document defaults`,
              href: `/t/${team.url}/settings/document`,
              icon: ShieldCheckIcon,
            },
          ].map((item) => (
            <Button key={item.label} asChild variant="outline" className="h-auto justify-start p-4">
              <Link to={item.href}>
                <item.icon className="mr-3 h-5 w-5" />
                {item.label}
              </Link>
            </Button>
          ))}
        </div>
      </section>

      <SendSmsDialog item={smsRecipient} onOpenChange={(open) => !open && setSmsRecipient(null)} />
    </div>
  );
};

const IntegrationHealth = ({ data, teamUrl }: { data: Overview; teamUrl: string }) => {
  const rows = [
    {
      label: 'Completion archive',
      description: `${data.integrations.archiveSuccessCount} archived · ${data.integrations.archiveFailureCount} failed`,
      ready:
        data.integrations.archiveProviderConfigured &&
        data.settings.archiveEnabled &&
        Boolean(data.settings.driveFolderId),
      icon: ArchiveIcon,
    },
    {
      label: 'SMS signing links',
      description: data.integrations.smsProviderConfigured
        ? 'Twilio provider is configured'
        : 'Twilio credentials are required',
      ready: data.integrations.smsProviderConfigured && data.settings.smsEnabled,
      icon: MessageSquareTextIcon,
    },
    {
      label: 'HR lifecycle handoff',
      description: `${data.integrations.enabledWebhookCount} enabled webhooks · ${data.integrations.recentWebhookFailures} recent failures`,
      ready: data.integrations.hrWebhookConfigured && data.integrations.recentWebhookFailures === 0,
      icon: WebhookIcon,
    },
    {
      label: 'Retention report',
      description: `${data.retentionCandidateCount} completed documents older than ${data.settings.retentionDays} days`,
      ready: data.retentionCandidateCount === 0,
      icon: ShieldCheckIcon,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Automation health</Trans>
        </CardTitle>
        <CardDescription>
          <Trans>Provider readiness and recent delivery outcomes.</Trans>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 rounded-lg border p-3">
            <row.icon className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{row.label}</p>
              <p className="text-muted-foreground text-xs">{row.description}</p>
            </div>
            <Badge variant={row.ready ? 'default' : 'secondary'}>{row.ready ? 'Ready' : 'Setup'}</Badge>
          </div>
        ))}
        <Button asChild variant="outline" className="w-full">
          <Link to={`/t/${teamUrl}/settings/webhooks`}>
            <WebhookIcon className="mr-2 h-4 w-4" />
            <Trans>Manage HR webhooks</Trans>
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
};

const OperationsSettingsForm = ({ data }: { data: Overview }) => {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const updateSettings = trpc.team.operations.updateSettings.useMutation();
  const [settings, setSettings] = useState(data.settings);

  const save = async () => {
    await updateSettings.mutateAsync({ data: settings });
    await utils.envelope.operations.overview.invalidate();
    toast({ title: 'Operations settings saved' });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Operations settings</Trans>
        </CardTitle>
        <CardDescription>
          <Trans>
            Outbound providers stay disabled until both server credentials and these team controls are ready.
          </Trans>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <SettingToggle
          label="Archive completed packets to Google Drive"
          description="Uploads sealed PDFs and a completion manifest after signing."
          checked={settings.archiveEnabled}
          onCheckedChange={(archiveEnabled) => setSettings({ ...settings, archiveEnabled })}
        />
        <div className="space-y-2">
          <Label htmlFor="drive-folder-id">
            <Trans>Google Drive folder ID</Trans>
          </Label>
          <Input
            id="drive-folder-id"
            value={settings.driveFolderId}
            placeholder="1AbC..."
            onChange={(event) => setSettings({ ...settings, driveFolderId: event.target.value.trim() })}
          />
        </div>
        <SettingToggle
          label="Allow manager-sent SMS signing links"
          description="Requires consent confirmation for every message; phone numbers are not retained."
          checked={settings.smsEnabled}
          onCheckedChange={(smsEnabled) => setSettings({ ...settings, smsEnabled })}
        />
        <SettingToggle
          label="Keep reminders inside business days"
          description="Weekend and after-hours manual reminders roll forward to the next delivery window."
          checked={settings.smartReminderBusinessDaysOnly}
          onCheckedChange={(smartReminderBusinessDaysOnly) =>
            setSettings({ ...settings, smartReminderBusinessDaysOnly })
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="start-hour">
              <Trans>Start hour</Trans>
            </Label>
            <Input
              id="start-hour"
              type="number"
              min={0}
              max={23}
              value={settings.smartReminderStartHour}
              onChange={(event) => setSettings({ ...settings, smartReminderStartHour: Number(event.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="end-hour">
              <Trans>End hour</Trans>
            </Label>
            <Input
              id="end-hour"
              type="number"
              min={1}
              max={24}
              value={settings.smartReminderEndHour}
              onChange={(event) => setSettings({ ...settings, smartReminderEndHour: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="retention-days">
            <Trans>Retention review age (days)</Trans>
          </Label>
          <Input
            id="retention-days"
            type="number"
            min={30}
            max={3650}
            value={settings.retentionDays}
            onChange={(event) => setSettings({ ...settings, retentionDays: Number(event.target.value) })}
          />
          <p className="text-muted-foreground text-xs">
            <Trans>Report-only: this never deletes documents automatically.</Trans>
          </p>
        </div>
        <Button className="w-full" loading={updateSettings.isPending} onClick={() => void save()}>
          <Trans>Save operations settings</Trans>
        </Button>
      </CardContent>
    </Card>
  );
};

const SettingToggle = ({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <div className="flex items-start justify-between gap-4">
    <div>
      <p className="font-medium text-sm">{label}</p>
      <p className="text-muted-foreground text-xs">{description}</p>
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

const SendSmsDialog = ({ item, onOpenChange }: { item: ActionItem | null; onOpenChange: (open: boolean) => void }) => {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const sendSms = trpc.envelope.operations.sendSigningLinkSms.useMutation();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [consentConfirmed, setConsentConfirmed] = useState(false);

  const send = async () => {
    if (!item || !consentConfirmed) {
      return;
    }
    const result = await sendSms.mutateAsync({
      envelopeId: item.envelopeId,
      recipientId: item.recipientId,
      phoneNumber,
      consentConfirmed: true,
    });
    await utils.envelope.operations.overview.invalidate();
    toast({ title: `SMS ${result.providerStatus}`, description: `Sent to the number ending in ${result.phoneLast4}.` });
    setPhoneNumber('');
    setConsentConfirmed(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Send signing link by SMS</Trans>
          </DialogTitle>
          <DialogDescription>
            {item ? `${item.recipientName || item.recipientEmail} · ${item.documentTitle}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sms-phone">
              <Trans>Mobile number</Trans>
            </Label>
            <Input
              id="sms-phone"
              type="tel"
              placeholder="+18327773002"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value.trim())}
            />
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="sms-consent"
              checked={consentConfirmed}
              onCheckedChange={(value) => setConsentConfirmed(value === true)}
            />
            <Label htmlFor="sms-consent" className="font-normal text-sm leading-5">
              <Trans>I confirm this recipient consented to receive this transactional signing message.</Trans>
            </Label>
          </div>
          <p className="text-muted-foreground text-xs">
            <Trans>The full phone number is sent to Twilio but is not saved in Documenso.</Trans>
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            loading={sendSms.isPending}
            disabled={!consentConfirmed || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)}
            onClick={() => void send()}
          >
            <MessageSquareTextIcon className="mr-2 h-4 w-4" />
            <Trans>Send text</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const ReasonBadge = ({ reason }: { reason: ActionItem['reason'] }) => {
  const labels: Record<ActionItem['reason'], string> = {
    DELIVERY_FAILED: 'Delivery failed',
    EXPIRED: 'Expired',
    OPENED_UNSIGNED: 'Opened, unsigned',
    NOT_OPENED: 'Not opened',
  };
  return (
    <Badge variant={reason === 'DELIVERY_FAILED' || reason === 'EXPIRED' ? 'destructive' : 'warning'}>
      {labels[reason]}
    </Badge>
  );
};

const formatDuration = (hours: number) => (hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`);
const formatMonth = (month: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00.000Z`),
  );

const OperationsLoadingState = () => (
  <div className="mx-auto w-full max-w-screen-2xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
    <div>
      <Skeleton className="h-10 w-80" />
      <Skeleton className="mt-3 h-5 w-[32rem] max-w-full" />
    </div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-32" />
      ))}
    </div>
    <div className="grid gap-6 xl:grid-cols-2">
      <Skeleton className="h-96" />
      <Skeleton className="h-96" />
    </div>
  </div>
);
