import { RECIPIENT_ROLES_DESCRIPTION } from '@documenso/lib/constants/recipient-roles';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { formatSigningLink, isRecipientExpired } from '@documenso/lib/utils/recipients';
import { CopyTextButton } from '@documenso/ui/components/common/copy-text-button';
import { SignatureIcon } from '@documenso/ui/icons/signature';
import { cn } from '@documenso/ui/lib/utils';
import { AvatarWithText } from '@documenso/ui/primitives/avatar';
import { Badge } from '@documenso/ui/primitives/badge';
import { PopoverHover } from '@documenso/ui/primitives/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import {
  DocumentStatus,
  RecipientRole,
  ScheduledReminderDeliveryStatus,
  ScheduledReminderProviderStatus,
  SigningStatus,
} from '@prisma/client';
import { TooltipArrow } from '@radix-ui/react-tooltip';
import {
  AlertTriangle,
  CalendarClockIcon,
  CheckIcon,
  CircleAlertIcon,
  Clock,
  Clock8Icon,
  Loader2Icon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  PenIcon,
  PlusIcon,
  RotateCwIcon,
  UserIcon,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { match } from 'ts-pattern';

export type DocumentPageViewRecipientsProps = {
  envelope: TEnvelope;
  documentRootPath: string;
};

export const DocumentPageViewRecipients = ({ envelope, documentRootPath }: DocumentPageViewRecipientsProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const recipients = envelope.recipients;
  const [shouldHighlightCopyButtons, setShouldHighlightCopyButtons] = useState(false);

  // Check for action=view-tokens query parameter and set highlighting state
  useEffect(() => {
    const hasViewTokensAction = searchParams.get('action') === 'copy-links';

    if (hasViewTokensAction) {
      setShouldHighlightCopyButtons(true);

      // Remove the query parameter immediately
      const params = new URLSearchParams(searchParams);
      params.delete('action');
      setSearchParams(params);
    }
  }, [searchParams, setSearchParams]);

  return (
    <section className="flex flex-col rounded-xl border border-border bg-widget dark:bg-background">
      <div className="flex flex-row items-center justify-between px-4 py-3">
        <h1 className="font-medium text-foreground">
          <Trans>Recipients</Trans>
        </h1>

        {!isDocumentCompleted(envelope.status) && (
          <Link
            to={`${documentRootPath}/${envelope.id}/edit?step=signers`}
            title={_(msg`Modify recipients`)}
            className="flex flex-row items-center justify-between"
          >
            {recipients.length === 0 ? <PlusIcon className="ml-2 h-4 w-4" /> : <PenIcon className="ml-2 h-3 w-3" />}
          </Link>
        )}
      </div>

      <ul className="divide-y border-t text-muted-foreground">
        {recipients.length === 0 && (
          <li className="flex flex-col items-center justify-center py-6 text-sm">
            <Trans>No recipients</Trans>
          </li>
        )}

        {recipients.map((recipient, i) => (
          <li key={recipient.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <AvatarWithText
              avatarFallback={recipient.email.slice(0, 1).toUpperCase()}
              primaryText={<p className="text-muted-foreground text-sm">{recipient.email}</p>}
              secondaryText={
                <p className="text-muted-foreground/70 text-xs">
                  {_(RECIPIENT_ROLES_DESCRIPTION[recipient.role].roleName)}
                </p>
              }
            />

            <div className="flex flex-row items-center">
              {envelope.status !== DocumentStatus.DRAFT && recipient.signingStatus === SigningStatus.SIGNED && (
                <Badge variant="default">
                  {match(recipient.role)
                    .with(RecipientRole.APPROVER, () => (
                      <>
                        <CheckIcon className="mr-1 h-3 w-3" />
                        <Trans>Approved</Trans>
                      </>
                    ))
                    .with(RecipientRole.CC, () =>
                      envelope.status === DocumentStatus.COMPLETED ? (
                        <>
                          <MailIcon className="mr-1 h-3 w-3" />
                          <Trans>Sent</Trans>
                        </>
                      ) : (
                        <>
                          <CheckIcon className="mr-1 h-3 w-3" />
                          <Trans>Ready</Trans>
                        </>
                      ),
                    )

                    .with(RecipientRole.SIGNER, () => (
                      <>
                        <SignatureIcon className="mr-1 h-3 w-3" />
                        <Trans>Signed</Trans>
                      </>
                    ))
                    .with(RecipientRole.VIEWER, () => (
                      <>
                        <MailOpenIcon className="mr-1 h-3 w-3" />
                        <Trans>Viewed</Trans>
                      </>
                    ))
                    .with(RecipientRole.ASSISTANT, () => (
                      <>
                        <UserIcon className="mr-1 h-3 w-3" />
                        <Trans>Assisted</Trans>
                      </>
                    ))
                    .exhaustive()}
                </Badge>
              )}

              {envelope.status !== DocumentStatus.DRAFT &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                isRecipientExpired(recipient) && (
                  <Badge variant="destructive">
                    <Clock8Icon className="mr-1 h-3 w-3" />
                    <Trans>Expired</Trans>
                  </Badge>
                )}

              {envelope.status !== DocumentStatus.DRAFT &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                !isRecipientExpired(recipient) && <PendingRecipientStatus recipient={recipient} />}

              {envelope.status !== DocumentStatus.DRAFT && recipient.signingStatus === SigningStatus.REJECTED && (
                <PopoverHover
                  trigger={
                    <Badge variant="destructive">
                      <AlertTriangle className="mr-1 h-3 w-3" />
                      <Trans>Rejected</Trans>
                    </Badge>
                  }
                >
                  <p className="text-sm">
                    <Trans>Reason for rejection: </Trans>
                  </p>

                  <p className="mt-1 text-muted-foreground text-sm">{recipient.rejectionReason}</p>
                </PopoverHover>
              )}

              {envelope.status === DocumentStatus.PENDING &&
                recipient.signingStatus === SigningStatus.NOT_SIGNED &&
                recipient.role !== RecipientRole.CC &&
                !isRecipientExpired(recipient) && (
                  <TooltipProvider>
                    <Tooltip open={shouldHighlightCopyButtons && i === 0}>
                      <TooltipTrigger asChild>
                        <div className={shouldHighlightCopyButtons ? 'animate-pulse' : ''}>
                          <CopyTextButton
                            value={formatSigningLink(recipient.token)}
                            onCopySuccess={() => {
                              toast({
                                title: _(msg`Copied to clipboard`),
                                description: _(msg`The signing link has been copied to your clipboard.`),
                              });
                              setShouldHighlightCopyButtons(false);
                            }}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={2}>
                        <Trans>Copy Signing Links</Trans>
                        <TooltipArrow className="fill-background" />
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

type PendingRecipientStatusProps = {
  recipient: TEnvelope['recipients'][number];
};

const PendingRecipientStatus = ({ recipient }: PendingRecipientStatusProps) => {
  const { i18n } = useLingui();
  const latestDelivery = recipient.scheduledReminderDeliveries?.[0];
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const activeScheduledAt =
    recipient.scheduledReminderAt ??
    (latestDelivery?.status === ScheduledReminderDeliveryStatus.PENDING ||
    latestDelivery?.status === ScheduledReminderDeliveryStatus.PROCESSING
      ? latestDelivery.scheduledAt
      : null);

  const isFailed = latestDelivery?.status === ScheduledReminderDeliveryStatus.FAILED;
  const isProcessing = latestDelivery?.status === ScheduledReminderDeliveryStatus.PROCESSING;
  const isSent = latestDelivery?.status === ScheduledReminderDeliveryStatus.SENT;
  const isProviderDelivered = latestDelivery?.providerStatus === ScheduledReminderProviderStatus.DELIVERED;
  const isProviderDelayed = latestDelivery?.providerStatus === ScheduledReminderProviderStatus.DELAYED;
  const isProviderFailed =
    latestDelivery?.providerStatus === ScheduledReminderProviderStatus.BOUNCED ||
    latestDelivery?.providerStatus === ScheduledReminderProviderStatus.FAILED ||
    latestDelivery?.providerStatus === ScheduledReminderProviderStatus.SUPPRESSED;
  const isRetrying =
    latestDelivery?.status === ScheduledReminderDeliveryStatus.PENDING && latestDelivery.attemptCount > 0;
  const isScheduled = Boolean(activeScheduledAt) && !isProcessing && !isRetrying;

  const ReminderIcon =
    isFailed || isProviderFailed
      ? CircleAlertIcon
      : isProviderDelayed
        ? Clock8Icon
        : isProcessing
          ? Loader2Icon
          : isRetrying
            ? RotateCwIcon
            : isProviderDelivered || isSent
              ? MailCheckIcon
              : isScheduled
                ? CalendarClockIcon
                : Clock;

  return (
    <PopoverHover
      contentProps={{ align: 'end' }}
      trigger={
        <Badge variant={isFailed || isProviderFailed ? 'destructive' : 'secondary'}>
          <ReminderIcon className={cn('mr-1 h-3 w-3', { 'animate-spin': isProcessing })} />
          <Trans>Pending</Trans>
          {isScheduled && (
            <>
              <span className="mx-1">·</span>
              <Trans>Reminder scheduled</Trans>
            </>
          )}
          {isProcessing && (
            <>
              <span className="mx-1">·</span>
              <Trans>Sending reminder</Trans>
            </>
          )}
          {isRetrying && (
            <>
              <span className="mx-1">·</span>
              <Trans>Retry queued</Trans>
            </>
          )}
          {isProviderDelivered && (
            <>
              <span className="mx-1">·</span>
              <Trans>Reminder delivered</Trans>
            </>
          )}
          {isProviderDelayed && (
            <>
              <span className="mx-1">·</span>
              <Trans>Delivery delayed</Trans>
            </>
          )}
          {isProviderFailed && (
            <>
              <span className="mx-1">·</span>
              <Trans>Delivery failed</Trans>
            </>
          )}
          {isSent && !isProviderDelivered && !isProviderDelayed && !isProviderFailed && (
            <>
              <span className="mx-1">·</span>
              <Trans>Reminder sent</Trans>
            </>
          )}
          {isFailed && (
            <>
              <span className="mx-1">·</span>
              <Trans>Reminder failed</Trans>
            </>
          )}
        </Badge>
      }
    >
      <div className="space-y-2 text-xs">
        <div>
          <p className="font-medium text-foreground">
            <Trans>Waiting for recipient action</Trans>
          </p>
          <p className="text-muted-foreground">{localTimeZone}</p>
        </div>

        {activeScheduledAt && (latestDelivery?.attemptCount ?? 0) === 0 && (
          <p className="text-muted-foreground">
            <Trans>Reminder scheduled for {i18n.date(activeScheduledAt, DateTime.DATETIME_MED)}.</Trans>
          </p>
        )}

        {latestDelivery?.status === ScheduledReminderDeliveryStatus.PENDING && latestDelivery.attemptCount > 0 && (
          <p className="text-muted-foreground">
            <Trans>
              Retry {latestDelivery.attemptCount + 1} is queued for{' '}
              {i18n.date(latestDelivery.nextAttemptAt, DateTime.DATETIME_MED)}.
            </Trans>
          </p>
        )}

        {isProcessing && (
          <p className="text-muted-foreground">
            <Trans>The reminder is being delivered now.</Trans>
          </p>
        )}

        {isSent && latestDelivery.sentAt && !isProviderDelivered && !isProviderDelayed && !isProviderFailed && (
          <p className="text-muted-foreground">
            <Trans>Reminder sent {i18n.date(latestDelivery.sentAt, DateTime.DATETIME_MED)}.</Trans>
            {latestDelivery.providerStatus === ScheduledReminderProviderStatus.SUBMITTED && (
              <Trans> Awaiting delivery confirmation.</Trans>
            )}
          </p>
        )}

        {isProviderDelivered && latestDelivery.providerDeliveredAt && (
          <p className="text-green-700 dark:text-green-400">
            <Trans>
              Delivered to the recipient's mail server{' '}
              {i18n.date(latestDelivery.providerDeliveredAt, DateTime.DATETIME_MED)}.
            </Trans>
          </p>
        )}

        {isProviderDelayed && latestDelivery.providerDelayedAt && (
          <p className="text-amber-700 dark:text-amber-400">
            <Trans>
              The recipient's mail server delayed delivery{' '}
              {i18n.date(latestDelivery.providerDelayedAt, DateTime.DATETIME_MED)}.
            </Trans>
          </p>
        )}

        {isProviderFailed && latestDelivery.providerFailedAt && (
          <p className="text-destructive">
            <Trans>
              The email provider reported a delivery failure{' '}
              {i18n.date(latestDelivery.providerFailedAt, DateTime.DATETIME_MED)}.
            </Trans>
            {latestDelivery.providerFailureCode ? ` (${latestDelivery.providerFailureCode})` : ''}
          </p>
        )}

        {isFailed && (
          <p className="text-destructive">
            <Trans>Reminder failed after {latestDelivery.attemptCount} attempts.</Trans>
            {latestDelivery.lastErrorCode ? ` (${latestDelivery.lastErrorCode})` : ''}
          </p>
        )}

        {latestDelivery?.status === ScheduledReminderDeliveryStatus.CANCELLED && latestDelivery.cancelledAt && (
          <p className="text-muted-foreground">
            <Trans>
              The last reminder was cancelled {i18n.date(latestDelivery.cancelledAt, DateTime.DATETIME_MED)}.
            </Trans>
          </p>
        )}

        {!activeScheduledAt && !latestDelivery && (
          <p className="text-muted-foreground">
            <Trans>No reminder is currently scheduled.</Trans>
          </p>
        )}

        {recipient.expiresAt && (
          <p className="border-border/60 border-t pt-2 text-muted-foreground">
            <Trans>Expires {i18n.date(recipient.expiresAt, DateTime.DATETIME_MED)}</Trans>
          </p>
        )}
      </div>
    </PopoverHover>
  );
};
