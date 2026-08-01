import { useUpdateSearchParams } from '@documenso/lib/client-only/hooks/use-update-search-params';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { findRecipientByEmail } from '@documenso/lib/utils/recipients';
import { formatDocumentsPath } from '@documenso/lib/utils/teams';
import type { TFindDocumentsResponse } from '@documenso/trpc/server/document-router/find-documents.types';
import { cn } from '@documenso/ui/lib/utils';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import type { DataTableColumnDef, RowSelectionState } from '@documenso/ui/primitives/data-table';
import { DataTable } from '@documenso/ui/primitives/data-table';
import { DataTablePagination } from '@documenso/ui/primitives/data-table-pagination';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { TableCell } from '@documenso/ui/primitives/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ScheduledReminderDeliveryStatus, ScheduledReminderProviderStatus } from '@prisma/client';
import { AlertCircleIcon, CalendarClockIcon, CheckCircle2Icon, Loader, Loader2Icon } from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo, useTransition } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { DocumentStatus } from '~/components/general/document/document-status';
import { useCurrentTeam } from '~/providers/team';

import { StackAvatarsWithTooltip } from '../general/stack-avatars-with-tooltip';
import { DocumentsTableActionButton } from './documents-table-action-button';
import { DocumentsTableActionDropdown } from './documents-table-action-dropdown';

export type DocumentsTableProps = {
  data?: TFindDocumentsResponse;
  isLoading?: boolean;
  isLoadingError?: boolean;
  onMoveDocument?: (envelopeId: string) => void;
  enableSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
};

type DocumentsTableRow = TFindDocumentsResponse['data'][number];

export const DocumentsTable = ({
  data,
  isLoading,
  isLoadingError,
  onMoveDocument,
  enableSelection,
  rowSelection,
  onRowSelectionChange,
}: DocumentsTableProps) => {
  const { _, i18n } = useLingui();

  const team = useCurrentTeam();
  const [isPending, startTransition] = useTransition();

  const updateSearchParams = useUpdateSearchParams();

  const columns = useMemo(() => {
    const cols: DataTableColumnDef<DocumentsTableRow>[] = [];

    if (enableSelection) {
      cols.push({
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label={_(msg`Select all`)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={_(msg`Select row`)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
        size: 40,
      });
    }

    cols.push(
      {
        header: _(msg`Created`),
        accessorKey: 'createdAt',
        cell: ({ row }) => i18n.date(row.original.createdAt, { ...DateTime.DATETIME_SHORT, hourCycle: 'h12' }),
      },
      {
        header: _(msg`Title`),
        cell: ({ row }) => <DataTableTitle row={row.original} teamUrl={team?.url} teamEmail={team?.teamEmail?.email} />,
      },
      {
        id: 'sender',
        header: _(msg`Sender`),
        cell: ({ row }) => row.original.user.name ?? row.original.user.email,
      },
      {
        header: _(msg`Recipient`),
        accessorKey: 'recipient',
        cell: ({ row }) => (
          <StackAvatarsWithTooltip recipients={row.original.recipients} documentStatus={row.original.status} />
        ),
      },
      {
        header: _(msg`Status`),
        accessorKey: 'status',
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1.5">
            <DocumentStatus status={row.original.status} />
            <ScheduledReminderStatus recipients={row.original.recipients} />
          </div>
        ),
        size: 190,
      },
      {
        header: _(msg`Actions`),
        cell: ({ row }) =>
          (!row.original.deletedAt || isDocumentCompleted(row.original.status)) && (
            <div className="flex items-center gap-x-4">
              <DocumentsTableActionButton row={row.original} />
              <DocumentsTableActionDropdown
                row={row.original}
                onMoveDocument={onMoveDocument ? () => onMoveDocument(row.original.envelopeId) : undefined}
              />
            </div>
          ),
      },
    );

    return cols;
  }, [team, onMoveDocument, enableSelection]);

  const onPaginationChange = (page: number, perPage: number) => {
    startTransition(() => {
      updateSearchParams({
        page,
        perPage,
      });
    });
  };

  const results = data ?? {
    data: [],
    perPage: 10,
    currentPage: 1,
    totalPages: 1,
  };

  return (
    <div className="relative">
      <DataTable
        columns={columns}
        data={results.data}
        perPage={results.perPage}
        currentPage={results.currentPage}
        totalPages={results.totalPages}
        onPaginationChange={onPaginationChange}
        columnVisibility={{
          sender: team !== undefined,
        }}
        error={{
          enable: isLoadingError || false,
        }}
        skeleton={{
          enable: isLoading || false,
          rows: 5,
          component: (
            <>
              {enableSelection && (
                <TableCell>
                  <Skeleton className="h-4 w-4 rounded" />
                </TableCell>
              )}
              <TableCell>
                <Skeleton className="h-4 w-40 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20 rounded-full" />
              </TableCell>
              <TableCell className="py-4">
                <div className="flex w-full flex-row items-center">
                  <Skeleton className="h-10 w-10 flex-shrink-0 rounded-full" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-10 w-24 rounded" />
              </TableCell>
            </>
          ),
        }}
        enableRowSelection={enableSelection}
        rowSelection={rowSelection}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.envelopeId}
      >
        {(table) => <DataTablePagination additionalInformation="VisibleCount" table={table} />}
      </DataTable>

      {isPending && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <Loader className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
};

type ScheduledReminderStatusProps = {
  recipients: DocumentsTableRow['recipients'];
};

const ScheduledReminderStatus = ({ recipients }: ScheduledReminderStatusProps) => {
  const { _, i18n } = useLingui();
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const reminderActivity = recipients.flatMap((recipient) => {
    const latestDelivery = recipient.scheduledReminderDeliveries?.[0];

    if (recipient.scheduledReminderAt instanceof Date) {
      return [
        {
          recipient,
          status: latestDelivery?.status ?? ScheduledReminderDeliveryStatus.PENDING,
          scheduledAt: recipient.scheduledReminderAt,
          nextAttemptAt: latestDelivery?.nextAttemptAt ?? recipient.scheduledReminderAt,
          attemptCount: latestDelivery?.attemptCount ?? 0,
          sentAt: latestDelivery?.sentAt ?? null,
          errorCode: latestDelivery?.lastErrorCode ?? null,
          providerStatus: latestDelivery?.providerStatus ?? null,
          providerDeliveredAt: latestDelivery?.providerDeliveredAt ?? null,
          providerDelayedAt: latestDelivery?.providerDelayedAt ?? null,
          providerFailedAt: latestDelivery?.providerFailedAt ?? null,
          providerFailureCode: latestDelivery?.providerFailureCode ?? null,
        },
      ];
    }

    if (
      latestDelivery?.status === ScheduledReminderDeliveryStatus.FAILED ||
      latestDelivery?.status === ScheduledReminderDeliveryStatus.PROCESSING ||
      latestDelivery?.status === ScheduledReminderDeliveryStatus.SENT
    ) {
      return [
        {
          recipient,
          status: latestDelivery.status,
          scheduledAt: latestDelivery.scheduledAt,
          nextAttemptAt: latestDelivery.nextAttemptAt,
          attemptCount: latestDelivery.attemptCount,
          sentAt: latestDelivery.sentAt,
          errorCode: latestDelivery.lastErrorCode,
          providerStatus: latestDelivery.providerStatus,
          providerDeliveredAt: latestDelivery.providerDeliveredAt,
          providerDelayedAt: latestDelivery.providerDelayedAt,
          providerFailedAt: latestDelivery.providerFailedAt,
          providerFailureCode: latestDelivery.providerFailureCode,
        },
      ];
    }

    return [];
  });

  if (reminderActivity.length === 0) {
    return null;
  }

  const hasFailure = reminderActivity.some((item) => item.status === ScheduledReminderDeliveryStatus.FAILED);
  const hasProviderFailure = reminderActivity.some(
    (item) =>
      item.providerStatus === ScheduledReminderProviderStatus.BOUNCED ||
      item.providerStatus === ScheduledReminderProviderStatus.FAILED ||
      item.providerStatus === ScheduledReminderProviderStatus.SUPPRESSED,
  );
  const hasProviderDelay = reminderActivity.some(
    (item) => item.providerStatus === ScheduledReminderProviderStatus.DELAYED,
  );
  const isSending = reminderActivity.some((item) => item.status === ScheduledReminderDeliveryStatus.PROCESSING);
  const isSent = reminderActivity.every((item) => item.status === ScheduledReminderDeliveryStatus.SENT);
  const isDelivered = reminderActivity.every(
    (item) => item.providerStatus === ScheduledReminderProviderStatus.DELIVERED,
  );

  const statusLabel =
    hasFailure || hasProviderFailure
      ? _(msg`Reminder failed`)
      : hasProviderDelay
        ? _(msg`Delivery delayed`)
        : isSending
          ? _(msg`Sending reminder`)
          : isDelivered
            ? _(msg`Reminder delivered`)
            : isSent
              ? _(msg`Reminder sent`)
              : reminderActivity.length === 1
                ? _(msg`Reminder scheduled`)
                : _(msg`Reminders scheduled`);

  const StatusIcon =
    hasFailure || hasProviderFailure
      ? AlertCircleIcon
      : hasProviderDelay
        ? CalendarClockIcon
        : isSending
          ? Loader2Icon
          : isDelivered || isSent
            ? CheckCircle2Icon
            : CalendarClockIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 rounded-sm text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            hasFailure || hasProviderFailure
              ? 'text-destructive'
              : hasProviderDelay
                ? 'text-amber-700 dark:text-amber-400'
                : isDelivered || isSent
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-blue-600 dark:text-blue-300',
          )}
          aria-label={_(msg`Reminder status. View details`)}
          onClick={(event) => event.stopPropagation()}
        >
          <StatusIcon className={cn('h-3.5 w-3.5', { 'animate-spin': isSending })} />
          {statusLabel}
        </button>
      </TooltipTrigger>

      <TooltipContent side="top" className="w-72 p-3">
        <p className="font-medium">
          <Trans>Reminder delivery details</Trans>
        </p>
        <p className="mt-0.5 text-muted-foreground text-xs">{localTimeZone}</p>

        <div className="mt-2 space-y-2">
          {reminderActivity.map((item) => (
            <div key={item.recipient.id} className="border-border/60 border-t pt-2 first:border-t-0 first:pt-0">
              <p className="truncate font-medium text-xs">{item.recipient.name || item.recipient.email}</p>
              {item.recipient.name && <p className="truncate text-muted-foreground text-xs">{item.recipient.email}</p>}
              <p className="mt-0.5 text-xs">
                {i18n.date(item.scheduledAt, {
                  ...DateTime.DATETIME_MED,
                  hourCycle: 'h12',
                })}
              </p>
              {item.status === ScheduledReminderDeliveryStatus.PENDING && item.attemptCount > 0 && (
                <p className="mt-0.5 text-muted-foreground text-xs">
                  <Trans>Retry {item.attemptCount + 1} is queued</Trans>
                </p>
              )}
              {item.status === ScheduledReminderDeliveryStatus.PROCESSING && (
                <p className="mt-0.5 text-muted-foreground text-xs">
                  <Trans>Delivery is in progress</Trans>
                </p>
              )}
              {item.status === ScheduledReminderDeliveryStatus.SENT && item.sentAt && (
                <p className="mt-0.5 text-muted-foreground text-xs">
                  <Trans>
                    Sent{' '}
                    {i18n.date(item.sentAt, {
                      ...DateTime.DATETIME_MED,
                      hourCycle: 'h12',
                    })}
                  </Trans>
                </p>
              )}
              {item.providerStatus === ScheduledReminderProviderStatus.DELIVERED && item.providerDeliveredAt && (
                <p className="mt-0.5 text-green-700 text-xs dark:text-green-400">
                  <Trans>
                    Delivered{' '}
                    {i18n.date(item.providerDeliveredAt, {
                      ...DateTime.DATETIME_MED,
                      hourCycle: 'h12',
                    })}
                  </Trans>
                </p>
              )}
              {item.providerStatus === ScheduledReminderProviderStatus.DELAYED && item.providerDelayedAt && (
                <p className="mt-0.5 text-amber-700 text-xs dark:text-amber-400">
                  <Trans>
                    Delivery delayed{' '}
                    {i18n.date(item.providerDelayedAt, {
                      ...DateTime.DATETIME_MED,
                      hourCycle: 'h12',
                    })}
                  </Trans>
                </p>
              )}
              {(item.providerStatus === ScheduledReminderProviderStatus.BOUNCED ||
                item.providerStatus === ScheduledReminderProviderStatus.FAILED ||
                item.providerStatus === ScheduledReminderProviderStatus.SUPPRESSED) && (
                <p className="mt-0.5 text-destructive text-xs">
                  <Trans>Provider delivery failed</Trans>
                  {item.providerFailureCode ? ` (${item.providerFailureCode})` : ''}
                </p>
              )}
              {item.status === ScheduledReminderDeliveryStatus.FAILED && (
                <p className="mt-0.5 text-destructive text-xs">
                  <Trans>Failed after {item.attemptCount} attempts</Trans>
                  {item.errorCode ? ` (${item.errorCode})` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

type DataTableTitleProps = {
  row: DocumentsTableRow;
  teamUrl: string;
  teamEmail?: string;
};

const DataTableTitle = ({ row, teamUrl, teamEmail }: DataTableTitleProps) => {
  const { user } = useSession();

  const recipient = findRecipientByEmail({
    recipients: row.recipients,
    userEmail: user.email,
    teamEmail,
  });

  const isOwner = row.user.id === user.id;
  const isRecipient = !!recipient;
  const isCurrentTeamDocument = teamUrl && row.team?.url === teamUrl;

  const documentsPath = formatDocumentsPath(teamUrl);
  const formatPath = `${documentsPath}/${row.envelopeId}`;

  return match({
    isOwner,
    isRecipient,
    isCurrentTeamDocument,
  })
    .with({ isOwner: true }, { isCurrentTeamDocument: true }, () => (
      <Link
        to={formatPath}
        title={row.title}
        className="block max-w-[10rem] truncate font-medium hover:underline md:max-w-[20rem]"
      >
        {row.title}
      </Link>
    ))
    .with({ isRecipient: true }, () => (
      <Link
        to={`/sign/${recipient?.token}`}
        title={row.title}
        className="block max-w-[10rem] truncate font-medium hover:underline md:max-w-[20rem]"
      >
        {row.title}
      </Link>
    ))
    .otherwise(() => (
      <span className="block max-w-[10rem] truncate font-medium hover:underline md:max-w-[20rem]">{row.title}</span>
    ));
};
