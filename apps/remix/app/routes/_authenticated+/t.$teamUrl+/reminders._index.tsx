import { getScheduledReminderDeliveryHealth } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { AppError } from '@documenso/lib/errors/app-error';
import { trpc } from '@documenso/trpc/react';
import type { TFindReminderSchedulesResponse } from '@documenso/trpc/server/envelope-router/find-reminder-schedules.types';
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
import { Input } from '@documenso/ui/primitives/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  Clock3Icon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useCurrentTeam } from '~/providers/team';
import { appMetaTags } from '~/utils/meta';

type ReminderSchedule = TFindReminderSchedulesResponse['data'][number];
type ReminderFilter = 'ALL' | 'SCHEDULED' | 'SENDING' | 'DELIVERED' | 'NEEDS_ATTENTION' | 'CANCELLED';

export function meta() {
  return appMetaTags(msg`Scheduled reminders`);
}

export default function ReminderSchedulesPage() {
  const { t } = useLingui();
  const { toast } = useToast();
  const team = useCurrentTeam();
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<ReminderFilter>('ALL');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ReminderSchedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const schedules = trpc.envelope.reminderSchedule.find.useQuery({ limit: 500 });
  const cancelSchedule = trpc.envelope.reminderSchedule.cancel.useMutation();
  const retryDelivery = trpc.envelope.reminderSchedule.retry.useMutation();

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

    return (schedules.data?.data ?? []).filter((row) => {
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
  }, [filter, schedules.data, search]);

  const deliveryHealth = useMemo(
    () => getScheduledReminderDeliveryHealth((schedules.data?.data ?? []).map((row) => row.status)),
    [schedules.data],
  );

  const columns = useMemo<DataTableColumnDef<ReminderSchedule>[]>(
    () => [
      {
        header: t`Next delivery`,
        cell: ({ row }) => <NextDelivery row={row.original} />,
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
        header: t`Status`,
        cell: ({ row }) => <ReminderStatus row={row.original} />,
      },
      {
        header: t`Actions`,
        cell: ({ row }) => {
          const isBusy = busyId === row.original.id;

          return (
            <div className="flex flex-wrap items-center gap-2">
              {row.original.canRetry && (
                <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void onRetry(row.original)}>
                  {isBusy ? (
                    <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="mr-1 h-4 w-4" />
                  )}
                  <Trans>Retry now</Trans>
                </Button>
              )}
              {row.original.canReschedule && (
                <Button size="sm" variant="outline" disabled={isBusy} onClick={() => setEditing(row.original)}>
                  <CalendarClockIcon className="mr-1 h-4 w-4" />
                  <Trans>Reschedule</Trans>
                </Button>
              )}
              {row.original.canCancel && (
                <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void onCancel(row.original)}>
                  {isBusy ? (
                    <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <XCircleIcon className="mr-1 h-4 w-4" />
                  )}
                  <Trans>Cancel</Trans>
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [busyId, team.url],
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
        isLoading={schedules.isLoading}
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
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </Badge>
        </div>

        <DataTable
          columns={columns}
          data={rows}
          skeleton={{ enable: schedules.isLoading, rows: 5 }}
          error={{ enable: schedules.isError }}
          emptyState={<Trans>No reminder schedules match these filters.</Trans>}
        />
        <p className="text-muted-foreground text-sm">
          <Trans>Showing {rows.length} reminder schedules.</Trans>
        </p>
      </div>

      <RescheduleDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} onSaved={refresh} />
    </div>
  );
}

const NextDelivery = ({ row }: { row: ReminderSchedule }) => {
  const date = row.nextDeliveryAt ?? row.scheduledAt;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit cursor-help items-start gap-2">
          <Clock3Icon className="mt-0.5 h-4 w-4 text-blue-600" />
          <div>
            <p className="font-medium">{formatDate(date, row.timezone)}</p>
            <p className="text-muted-foreground text-xs">{row.timezone}</p>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>
          {row.nextDeliveryAt
            ? `Next reminder: ${formatDate(row.nextDeliveryAt, row.timezone)}`
            : 'No future delivery queued'}
        </p>
        <p>Last activity: {formatDate(row.lastActivityAt, row.timezone)}</p>
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
            <Trans>Current reminder outcomes. Recipient details remain in the table below.</Trans>
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

const ReminderStatus = ({ row }: { row: ReminderSchedule }) => {
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
        <p>Last activity: {formatDate(row.lastActivityAt, row.timezone)}</p>
        {row.lastErrorMessage && <p>{row.lastErrorMessage}</p>}
        {row.lastErrorCode && <p className="text-xs opacity-80">Code: {row.lastErrorCode}</p>}
      </TooltipContent>
    </Tooltip>
  );
};

const RescheduleDialog = ({
  row,
  onOpenChange,
  onSaved,
}: {
  row: ReminderSchedule | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    if (!row || !scheduledAt) {
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
            <Input value={localTimezone} readOnly />
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
          <Button loading={updateSchedule.isPending} disabled={!scheduledAt} onClick={() => void save()}>
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
