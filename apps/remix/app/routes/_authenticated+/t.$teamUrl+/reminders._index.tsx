import { getScheduledReminderDeliveryHealth } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { AppError } from '@documenso/lib/errors/app-error';
import { getReminderNextDeliveryDisplay } from '@documenso/lib/universal/reminder-next-delivery';
import { trpc } from '@documenso/trpc/react';
import type { TFindReminderSchedulesResponse } from '@documenso/trpc/server/envelope-router/find-reminder-schedules.types';
import { ClientOnly } from '@documenso/ui/components/client-only';
import { cn } from '@documenso/ui/lib/utils';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import type { DataTableColumnDef } from '@documenso/ui/primitives/data-table';
import { DataTable } from '@documenso/ui/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Input } from '@documenso/ui/primitives/input';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  Clock3Icon,
  DownloadIcon,
  EyeIcon,
  FileCheck2Icon,
  HistoryIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SignatureIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { DocumentStatus as DocumentStatusComponent } from '~/components/general/document/document-status';
import { useCurrentTeam } from '~/providers/team';
import { appMetaTags } from '~/utils/meta';

type ReminderSchedule = TFindReminderSchedulesResponse['data'][number];
type ReminderFilter = 'ALL' | 'SCHEDULED' | 'SENDING' | 'DELIVERED' | 'NEEDS_ATTENTION' | 'CANCELLED';

export function meta() {
  return appMetaTags(msg`Scheduled reminders`);
}

export default function ReminderSchedulesPage() {
  return (
    <ClientOnly fallback={<ReminderSchedulesPageLoadingState />}>{() => <ReminderSchedulesPageContent />}</ClientOnly>
  );
}

const ReminderSchedulesPageContent = () => {
  const { t } = useLingui();
  const { toast } = useToast();
  const team = useCurrentTeam();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<ReminderFilter>('ALL');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ReminderSchedule | null>(null);
  const [viewingActivity, setViewingActivity] = useState<ReminderSchedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const schedules = trpc.envelope.reminderSchedule.find.useQuery(
    { limit: 500 },
    {
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  );
  const cancelSchedule = trpc.envelope.reminderSchedule.cancel.useMutation();
  const retryDelivery = trpc.envelope.reminderSchedule.retry.useMutation();
  const scheduleData = schedules.data?.data ?? [];
  const isScheduleDataLoading = schedules.isLoading;
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const refresh = async () => {
    await Promise.allSettled([
      utils.envelope.reminderSchedule.find.invalidate(),
      utils.document.findDocumentsInternal.invalidate(),
      utils.document.auditLog.find.invalidate(),
    ]);
  };

  const onCancel = async (row: ReminderSchedule) => {
    if (!window.confirm(t`Cancel the remaining reminders in this schedule?`)) {
      return;
    }

    setBusyId(row.id);

    try {
      await cancelSchedule.mutateAsync({ sequenceId: row.sequenceId, primaryDeliveryId: row.primaryDeliveryId });
      await refresh();
      toast({ title: t`Reminder schedule cancelled`, duration: 5000 });
    } catch (error) {
      toast({
        title: t`Could not cancel reminder schedule`,
        description: AppError.parseError(error).message,
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const onRetry = async (row: ReminderSchedule) => {
    if (!row.retryDeliveryId) {
      return;
    }

    setBusyId(row.id);

    try {
      await retryDelivery.mutateAsync({ deliveryId: row.retryDeliveryId });
      await refresh();
      toast({ title: t`Reminder retry queued`, description: t`Delivery will run within about five minutes.` });
    } catch (error) {
      toast({
        title: t`This reminder could not be retried`,
        description: AppError.parseError(error).message,
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const rows = useMemo(() => {
    const searchValue = search.trim().toLowerCase();

    return scheduleData.filter((row) => {
      const matchesSearch =
        !searchValue ||
        [row.documentTitle, row.recipient.name, row.recipient.email].some((value) =>
          value.toLowerCase().includes(searchValue),
        );

      if (!matchesSearch || filter === 'ALL') {
        return matchesSearch;
      }

      if (filter === 'SENDING') {
        return ['SENDING', 'SUBMITTED', 'DELAYED'].includes(row.status);
      }

      if (filter === 'NEEDS_ATTENTION') {
        return ['NEEDS_ATTENTION', 'PERMANENT_FAILURE'].includes(row.status);
      }

      return row.status === filter;
    });
  }, [filter, scheduleData, search]);

  const deliveryHealth = useMemo(
    () => getScheduledReminderDeliveryHealth(scheduleData.map((row) => row.status)),
    [scheduleData],
  );

  const columns = useMemo<DataTableColumnDef<ReminderSchedule>[]>(
    () => [
      {
        header: t`Next delivery`,
        cell: ({ row }) => <NextDelivery row={row.original} timezone={localTimezone ?? row.original.timezone} />,
      },
      {
        header: t`Document`,
        cell: ({ row }) => (
          <Link className="font-medium hover:underline" to={`/t/${team.url}/documents/${row.original.envelopeId}`}>
            {row.original.documentTitle}
          </Link>
        ),
      },
      {
        header: t`Recipient`,
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.recipient.name || row.original.recipient.email}</p>
            <p className="text-muted-foreground text-xs">{row.original.recipient.email}</p>
          </div>
        ),
      },
      {
        header: t`Sequence`,
        cell: ({ row }) =>
          row.original.sequenceTotal > 1 ? (
            <div>
              <p>
                {Math.min(row.original.sequencePosition + 1, row.original.sequenceTotal)} of{' '}
                {row.original.sequenceTotal}
              </p>
              <p className="text-muted-foreground text-xs">
                <Trans>Every {row.original.sequenceIntervalDays} days</Trans>
              </p>
            </div>
          ) : (
            <Trans>One reminder</Trans>
          ),
      },
      {
        header: t`Document status`,
        cell: ({ row }) => (
          <div>
            <DocumentStatusComponent status={row.original.documentStatus} />
            {row.original.documentCompletedAt && (
              <p className="mt-1 text-muted-foreground text-xs">
                <Trans>
                  Completed {formatDate(row.original.documentCompletedAt, localTimezone ?? row.original.timezone)}
                </Trans>
              </p>
            )}
          </div>
        ),
      },
      {
        header: t`Email delivery`,
        cell: ({ row }) => <ReminderStatus row={row.original} timezone={localTimezone ?? row.original.timezone} />,
      },
      {
        header: t`Actions`,
        cell: ({ row }) => {
          const isBusy = busyId === row.original.id;

          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={isBusy}>
                  {isBusy ? (
                    <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <MoreHorizontalIcon className="mr-1 h-4 w-4" />
                  )}
                  <Trans>Actions</Trans>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-52" align="end" forceMount>
                <DropdownMenuLabel>
                  <Trans>Document</Trans>
                </DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link to={`/t/${team.url}/documents/${row.original.envelopeId}`}>
                    <EyeIcon className="mr-2 h-4 w-4" />
                    <Trans>View document</Trans>
                  </Link>
                </DropdownMenuItem>
                <EnvelopeDownloadDialog
                  envelopeId={row.original.envelopeId}
                  envelopeStatus={row.original.documentStatus}
                  trigger={
                    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
                      <div>
                        <DownloadIcon className="mr-2 h-4 w-4" />
                        <Trans>Download</Trans>
                      </div>
                    </DropdownMenuItem>
                  }
                />
                <DropdownMenuItem asChild>
                  <Link to={`/t/${team.url}/documents/${row.original.envelopeId}/logs`}>
                    <ScrollTextIcon className="mr-2 h-4 w-4" />
                    <Trans>Audit logs</Trans>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setViewingActivity(row.original)}>
                  <HistoryIcon className="mr-2 h-4 w-4" />
                  <Trans>View activity</Trans>
                </DropdownMenuItem>

                {(row.original.canRetry || row.original.canReschedule || row.original.canCancel) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      <Trans>Reminder</Trans>
                    </DropdownMenuLabel>
                  </>
                )}
                {row.original.canRetry && (
                  <DropdownMenuItem disabled={isBusy} onSelect={() => void onRetry(row.original)}>
                    <RefreshCwIcon className="mr-2 h-4 w-4" />
                    <Trans>Retry now</Trans>
                  </DropdownMenuItem>
                )}
                {row.original.canReschedule && (
                  <DropdownMenuItem disabled={isBusy} onSelect={() => setEditing(row.original)}>
                    <CalendarClockIcon className="mr-2 h-4 w-4" />
                    <Trans>Reschedule</Trans>
                  </DropdownMenuItem>
                )}
                {row.original.canCancel && (
                  <DropdownMenuItem disabled={isBusy} onSelect={() => void onCancel(row.original)}>
                    <XCircleIcon className="mr-2 h-4 w-4" />
                    <Trans>Cancel remaining</Trans>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [busyId, localTimezone, team.url],
  );

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-8 md:px-8">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="font-semibold text-3xl tracking-tight">
            <Trans>Scheduled reminders</Trans>
          </h1>
          <p className="mt-1 text-muted-foreground">
            <Trans>Manage upcoming reminders and delivery follow-up.</Trans>
          </p>
        </div>
        <div className="flex max-w-xl items-start gap-2 text-muted-foreground text-sm">
          <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <Trans>Reminders stop when a document completes, is cancelled, expires, or the recipient signs.</Trans>
        </div>
      </div>

      <DeliveryHealthSummary
        health={deliveryHealth}
        isLoading={isScheduleDataLoading}
        activeFilter={filter}
        onFilterChange={setFilter}
      />

      <div className="mt-8 flex flex-col gap-4">
        <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
          {(['ALL', 'SCHEDULED', 'SENDING', 'DELIVERED', 'NEEDS_ATTENTION', 'CANCELLED'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'outline' : 'ghost'}
              className={cn(filter === value && 'bg-background')}
              onClick={() => setFilter(value)}
            >
              {getFilterLabel(value)}
            </Button>
          ))}
        </div>

        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-sm">
            <SearchIcon className="absolute top-2.5 left-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t`Search reminders...`}
              className="pl-9"
            />
          </div>
          <Badge variant="neutral" size="large">
            {localTimezone ?? <Trans>Local timezone</Trans>}
          </Badge>
        </div>

        <DataTable
          columns={columns}
          data={rows}
          skeleton={{ enable: isScheduleDataLoading, rows: 5 }}
          error={{ enable: schedules.isError }}
          emptyState={<Trans>No reminder schedules match these filters.</Trans>}
        />
        <p className="text-muted-foreground text-sm">
          <Trans>Showing {rows.length} reminder schedules.</Trans>
        </p>
      </div>

      <RescheduleDialog
        row={editing}
        localTimezone={localTimezone}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={refresh}
      />
      <ReminderActivityDialog
        row={viewingActivity}
        timezone={localTimezone ?? viewingActivity?.timezone ?? 'America/Chicago'}
        onOpenChange={(open) => !open && setViewingActivity(null)}
      />
    </div>
  );
};

const ReminderSchedulesPageLoadingState = () => (
  <div className="mx-auto w-full max-w-screen-xl px-4 py-8 md:px-8" aria-busy="true">
    <span className="sr-only">
      <Trans>Loading reminders</Trans>
    </span>
    <Skeleton className="h-12 w-72" />
    <div className="mt-8 grid gap-4 md:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-36 rounded-lg" />
      ))}
    </div>
    <Skeleton className="mt-8 h-12 w-full rounded-lg" />
    <Skeleton className="mt-6 h-64 w-full rounded-lg" />
  </div>
);

const NextDelivery = ({ row, timezone }: { row: ReminderSchedule; timezone: string }) => {
  const display = getReminderNextDeliveryDisplay({
    documentStatus: row.documentStatus,
    documentCompletedAt: row.documentCompletedAt,
    nextDeliveryAt: row.nextDeliveryAt,
    lastActivityAt: row.lastActivityAt,
  });
  const isCompleted = display.state === 'COMPLETED';
  const isScheduled = display.state === 'SCHEDULED';
  const DeliveryIcon = isCompleted ? FileCheck2Icon : Clock3Icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit cursor-help items-start gap-2">
          <DeliveryIcon
            className={cn(
              'mt-0.5 h-4 w-4',
              isCompleted && 'text-green-600 dark:text-green-400',
              isScheduled && 'text-blue-600 dark:text-blue-300',
              !isCompleted && !isScheduled && 'text-muted-foreground',
            )}
          />
          <div>
            <p className="font-medium">{formatDate(display.date, timezone)}</p>
            <p className="text-muted-foreground text-xs">{isCompleted ? <Trans>Completed</Trans> : timezone}</p>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {isCompleted ? (
          <>
            <p>Document completed: {formatDate(display.date, timezone)}</p>
            <p>No future delivery queued</p>
          </>
        ) : (
          <p>
            {row.nextDeliveryAt
              ? `Next reminder: ${formatDate(row.nextDeliveryAt, timezone)}`
              : 'No future delivery queued'}
          </p>
        )}
        <p>Last reminder activity: {formatDate(row.lastActivityAt, timezone)}</p>
      </TooltipContent>
    </Tooltip>
  );
};

type DeliveryHealthSummaryProps = {
  health: ReturnType<typeof getScheduledReminderDeliveryHealth>;
  isLoading: boolean;
  activeFilter: ReminderFilter;
  onFilterChange: (filter: ReminderFilter) => void;
};

const DeliveryHealthSummary = ({ health, isLoading, activeFilter, onFilterChange }: DeliveryHealthSummaryProps) => {
  const { t } = useLingui();
  const cards = [
    {
      key: 'sent',
      label: t`Sent / in transit`,
      description: t`Accepted or moving through delivery`,
      value: health.sent,
      filter: 'SENDING' as const,
      icon: SendIcon,
      iconClassName: 'text-blue-600 dark:text-blue-300',
    },
    {
      key: 'delivered',
      label: t`Delivered`,
      description: t`Confirmed by the email provider`,
      value: health.delivered,
      filter: 'DELIVERED' as const,
      icon: CheckCircle2Icon,
      iconClassName: 'text-green-600 dark:text-green-400',
    },
    {
      key: 'failed',
      label: t`Needs attention`,
      description: t`Retryable or permanent failures`,
      value: health.failed,
      filter: 'NEEDS_ATTENTION' as const,
      icon: AlertTriangleIcon,
      iconClassName: health.failed > 0 ? 'text-destructive' : 'text-muted-foreground',
    },
    {
      key: 'stopped',
      label: t`Stopped`,
      description: t`Cancelled by a user or stop rule`,
      value: health.stopped,
      filter: 'CANCELLED' as const,
      icon: XCircleIcon,
      iconClassName: 'text-muted-foreground',
    },
  ];

  return (
    <section className="mt-6" aria-labelledby="delivery-health-heading" aria-busy={isLoading}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="delivery-health-heading" className="font-medium text-lg">
            <Trans>Delivery health</Trans>
          </h2>
          <p className="text-muted-foreground text-sm">
            <Trans>Reminder email outcomes. Document signing status appears separately in the table below.</Trans>
          </p>
        </div>
        <p className="text-muted-foreground text-sm">
          <Trans>{health.scheduled} scheduled and waiting</Trans>
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const isActive = activeFilter === card.filter;

          return (
            <button
              key={card.key}
              type="button"
              className={cn(
                'rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'border-primary bg-muted/40',
              )}
              aria-pressed={isActive}
              onClick={() => onFilterChange(isActive ? 'ALL' : card.filter)}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-sm">{card.label}</p>
                  <p className="mt-1 text-muted-foreground text-xs">{card.description}</p>
                </div>
                <Icon className={cn('h-5 w-5 shrink-0', card.iconClassName)} />
              </div>
              <p className="mt-3 font-semibold text-2xl tabular-nums">{isLoading ? '—' : card.value}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
};

const ReminderStatus = ({ row, timezone }: { row: ReminderSchedule; timezone: string }) => {
  const config = {
    SCHEDULED: { label: 'Scheduled', variant: 'secondary' as const, icon: CalendarClockIcon },
    SENDING: { label: 'Sending', variant: 'secondary' as const, icon: SendIcon },
    SUBMITTED: { label: 'Submitted', variant: 'secondary' as const, icon: SendIcon },
    DELAYED: { label: 'Delayed', variant: 'warning' as const, icon: Clock3Icon },
    DELIVERED: { label: 'Delivered', variant: 'default' as const, icon: CheckCircle2Icon },
    NEEDS_ATTENTION: { label: 'Needs attention', variant: 'warning' as const, icon: AlertTriangleIcon },
    PERMANENT_FAILURE: { label: 'Permanent failure', variant: 'destructive' as const, icon: XCircleIcon },
    CANCELLED: { label: 'Cancelled', variant: 'neutral' as const, icon: XCircleIcon },
  }[row.status];
  const Icon = config.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={config.variant} className="cursor-help gap-1">
          <Icon className="h-3.5 w-3.5" />
          {config.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>Last activity: {formatDate(row.lastActivityAt, timezone)}</p>
        {row.lastErrorMessage && <p>{row.lastErrorMessage}</p>}
        {row.lastErrorCode && <p className="text-xs opacity-80">Code: {row.lastErrorCode}</p>}
      </TooltipContent>
    </Tooltip>
  );
};

const ReminderActivityDialog = ({
  row,
  timezone,
  onOpenChange,
}: {
  row: ReminderSchedule | null;
  timezone: string;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={row !== null} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          <Trans>Reminder activity</Trans>
        </DialogTitle>
        <DialogDescription>{row?.documentTitle}</DialogDescription>
      </DialogHeader>
      {row && row.activity.length > 0 ? (
        <ol className="max-h-[60vh] space-y-0 overflow-y-auto pr-2">
          {row.activity.map((item, index) => {
            const config = getActivityConfig(item.type);
            const Icon = config.icon;

            return (
              <li key={`${item.type}-${item.occurredAt.toISOString()}-${item.sequencePosition ?? index}`}>
                <div className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={cn('rounded-full border bg-background p-1.5', config.iconClassName)}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    {index < row.activity.length - 1 && <span className="h-full min-h-8 w-px bg-border" />}
                  </div>
                  <div className="pb-4">
                    <p className="font-medium text-sm">
                      {config.label}
                      {item.sequencePosition !== null && row.sequenceTotal > 1
                        ? ` · Reminder ${item.sequencePosition}`
                        : ''}
                    </p>
                    <p className="text-muted-foreground text-xs">{formatDate(item.occurredAt, timezone)}</p>
                    {item.scheduledFor && (
                      <p className="mt-1 text-muted-foreground text-xs">
                        Scheduled for {formatDate(item.scheduledFor, timezone)}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground text-sm">
          <Trans>No reminder activity has been recorded.</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          <Trans>Close</Trans>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

const getActivityConfig = (type: ReminderSchedule['activity'][number]['type']) =>
  ({
    SCHEDULE_CREATED: { label: 'Schedule created', icon: CalendarClockIcon, iconClassName: 'text-blue-600' },
    REMINDER_SUBMITTED: { label: 'Submitted to email provider', icon: SendIcon, iconClassName: 'text-blue-600' },
    DELIVERY_DELAYED: { label: 'Delivery delayed', icon: Clock3Icon, iconClassName: 'text-amber-600' },
    DELIVERED: { label: 'Delivered by email provider', icon: CheckCircle2Icon, iconClassName: 'text-green-600' },
    BOUNCED: { label: 'Email bounced', icon: XCircleIcon, iconClassName: 'text-destructive' },
    DELIVERY_FAILED: { label: 'Email delivery failed', icon: AlertTriangleIcon, iconClassName: 'text-destructive' },
    SUPPRESSED: { label: 'Email suppressed', icon: XCircleIcon, iconClassName: 'text-destructive' },
    CANCELLED: { label: 'Reminder cancelled', icon: XCircleIcon, iconClassName: 'text-muted-foreground' },
    RECIPIENT_SIGNED: { label: 'Recipient signed', icon: SignatureIcon, iconClassName: 'text-green-600' },
    DOCUMENT_COMPLETED: { label: 'Document completed', icon: FileCheck2Icon, iconClassName: 'text-green-600' },
  })[type];

const RescheduleDialog = ({
  row,
  localTimezone,
  onOpenChange,
  onSaved,
}: {
  row: ReminderSchedule | null;
  localTimezone: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const [scheduledAt, setScheduledAt] = useState('');
  const [total, setTotal] = useState(1);
  const [intervalDays, setIntervalDays] = useState(3);
  const updateSchedule = trpc.envelope.reminderSchedule.update.useMutation();

  useEffect(() => {
    if (!row) {
      return;
    }

    setScheduledAt(toLocalInput(row.nextDeliveryAt ?? row.scheduledAt));
    setTotal(row.sequenceTotal);
    setIntervalDays(row.sequenceIntervalDays ?? 3);
  }, [row]);

  const save = async () => {
    if (!row || !scheduledAt || !localTimezone) {
      return;
    }

    try {
      await updateSchedule.mutateAsync({
        envelopeId: row.envelopeId,
        recipients: [row.recipient.id],
        scheduledAt: new Date(scheduledAt),
        timezone: localTimezone,
        total,
        intervalDays: total > 1 ? intervalDays : null,
      });
      await onSaved();
      toast({ title: t`Reminder schedule updated` });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t`Could not update reminder schedule`,
        description: AppError.parseError(error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Reschedule reminders</Trans>
          </DialogTitle>
          <DialogDescription>{row?.recipient.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">
              <Trans>First reminder</Trans>
            </span>
            <Input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">
              <Trans>Timezone</Trans>
            </span>
            <Input value={localTimezone ?? ''} readOnly />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">
                <Trans>Total reminders</Trans>
              </span>
              <Input
                type="number"
                min={1}
                max={5}
                value={total}
                onChange={(event) => setTotal(Number(event.target.value))}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">
                <Trans>Repeat every (days)</Trans>
              </span>
              <Input
                type="number"
                min={1}
                max={30}
                value={intervalDays}
                disabled={total === 1}
                onChange={(event) => setIntervalDays(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="rounded-md border px-3 py-2 text-muted-foreground text-xs">
            <Trans>Maximum 5 reminders. Stops automatically when the recipient can no longer receive reminders.</Trans>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={updateSchedule.isPending} onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            loading={updateSchedule.isPending}
            disabled={!scheduledAt || !localTimezone}
            onClick={() => void save()}
          >
            {updateSchedule.isPending ? <Trans>Saving...</Trans> : <Trans>Save schedule</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const formatDate = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(date);

const toLocalInput = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const getFilterLabel = (filter: ReminderFilter) =>
  ({
    ALL: 'All',
    SCHEDULED: 'Scheduled',
    SENDING: 'Sending',
    DELIVERED: 'Delivered',
    NEEDS_ATTENTION: 'Needs attention',
    CANCELLED: 'Cancelled',
  })[filter];
