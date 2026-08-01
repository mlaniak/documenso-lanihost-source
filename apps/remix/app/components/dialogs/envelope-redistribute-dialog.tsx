import { getRecipientType } from '@documenso/lib/client-only/recipient-type';
import { AppError } from '@documenso/lib/errors/app-error';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import type { TEnvelopeRecipientLite } from '@documenso/lib/types/recipient';
import { recipientAbbreviation } from '@documenso/lib/utils/recipient-formatter';
import { trpc as trpcReact } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@documenso/ui/primitives/form/form';
import { Input } from '@documenso/ui/primitives/input';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus, EnvelopeType, SigningStatus } from '@prisma/client';
import { CalendarClockIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { match } from 'ts-pattern';
import * as z from 'zod';
import { getDistributeErrorMessage } from '~/utils/toast-error-messages';
import { StackAvatar } from '../general/stack-avatar';

export type EnvelopeRedistributeDialogProps = {
  envelope: Pick<TEnvelope, 'id' | 'status' | 'type'> & {
    recipients: TEnvelopeRecipientLite[];
  };
  envelopeType?: EnvelopeType;
  trigger?: React.ReactNode;
};

export const ZEnvelopeRedistributeFormSchema = z
  .object({
    recipients: z.array(z.number()).min(1, {
      message: msg`You must select at least one item`.id,
    }),
    delivery: z.enum(['now', 'scheduled']),
    scheduledAt: z.string(),
  })
  .superRefine((value, context) => {
    if (value.delivery !== 'scheduled') {
      return;
    }

    const scheduledAt = new Date(value.scheduledAt);

    if (!value.scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg`Choose a future date and time`.id,
        path: ['scheduledAt'],
      });
    }
  });

export type TEnvelopeRedistributeFormSchema = z.infer<typeof ZEnvelopeRedistributeFormSchema>;

export const EnvelopeRedistributeDialog = ({ envelope, envelopeType, trigger }: EnvelopeRedistributeDialogProps) => {
  const recipients = envelope.recipients;

  const { toast } = useToast();
  const { t, i18n } = useLingui();
  const trpcUtils = trpcReact.useUtils();
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [isOpen, setIsOpen] = useState(false);
  const [scheduledReminderDates, setScheduledReminderDates] = useState<Record<number, Date | null>>({});

  const { mutateAsync: redistributeEnvelope } = trpcReact.envelope.redistribute.useMutation();
  const { mutateAsync: updateReminderSchedule, isPending: isUpdatingReminderSchedule } =
    trpcReact.envelope.reminderSchedule.update.useMutation();

  const form = useForm<TEnvelopeRedistributeFormSchema>({
    defaultValues: {
      recipients: [],
      delivery: 'now',
      scheduledAt: '',
    },
    resolver: zodResolver(ZEnvelopeRedistributeFormSchema),
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = form;

  const delivery = form.watch('delivery');
  const isBusy = isSubmitting || isUpdatingReminderSchedule;

  const refreshReminderData = async () => {
    await Promise.allSettled([
      trpcUtils.document.findDocumentsInternal.invalidate(),
      trpcUtils.document.auditLog.find.invalidate(),
      trpcUtils.envelope.get.invalidate(),
    ]);
  };

  const onFormSubmit = async ({ recipients, delivery, scheduledAt }: TEnvelopeRedistributeFormSchema) => {
    try {
      if (delivery === 'scheduled') {
        const response = await updateReminderSchedule({
          envelopeId: envelope.id,
          recipients,
          scheduledAt: new Date(scheduledAt),
        });

        setScheduledReminderDates((current) => ({
          ...current,
          ...Object.fromEntries(response.recipients.map((recipient) => [recipient.id, recipient.scheduledReminderAt])),
        }));

        await refreshReminderData();

        toast({
          title: t`Reminder scheduled`,
          description: t`Reminder set for ${new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(scheduledAt))} (${localTimeZone}).`,
          duration: 5000,
        });

        setIsOpen(false);
        return;
      }

      await redistributeEnvelope({ envelopeId: envelope.id, recipients });

      const successMessage = match(envelopeType)
        .with(EnvelopeType.DOCUMENT, () => ({
          title: t`Document resent`,
          description: t`Your document has been resent successfully.`,
        }))
        .with(EnvelopeType.TEMPLATE, () => ({
          title: t`Template resent`,
          description: t`Your template has been resent successfully.`,
        }))
        .otherwise(() => ({
          title: t`Envelope resent`,
          description: t`Your envelope has been resent successfully.`,
        }));

      toast({
        title: successMessage.title,
        description: successMessage.description,
        duration: 5000,
      });

      setIsOpen(false);
    } catch (err) {
      const error = AppError.parseError(err);
      const errorMessage = getDistributeErrorMessage(error.code);

      toast({
        title: i18n._(errorMessage.title),
        description: i18n._(errorMessage.description),
        variant: 'destructive',
        duration: 7500,
      });
    }
  };

  const onCancelScheduledReminder = async (recipientId: number) => {
    try {
      await updateReminderSchedule({
        envelopeId: envelope.id,
        recipients: [recipientId],
        scheduledAt: null,
      });

      setScheduledReminderDates((current) => ({ ...current, [recipientId]: null }));

      await refreshReminderData();

      toast({
        title: t`Scheduled reminder cancelled`,
        description: t`The recipient will not receive the one-off scheduled reminder.`,
        duration: 5000,
      });
    } catch (err) {
      const error = AppError.parseError(err);
      const errorMessage = getDistributeErrorMessage(error.code);

      toast({
        title: i18n._(errorMessage.title),
        description: i18n._(errorMessage.description),
        variant: 'destructive',
        duration: 7500,
      });
    }
  };

  useEffect(() => {
    if (!isOpen) {
      form.reset();
      return;
    }

    setScheduledReminderDates(
      Object.fromEntries(recipients.map((recipient) => [recipient.id, recipient.scheduledReminderAt ?? null])),
    );
  }, [isOpen]);

  if (envelope.status !== DocumentStatus.PENDING || envelope.type !== EnvelopeType.DOCUMENT) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>
            <Trans>Resend Document</Trans>
          </DialogTitle>

          <DialogDescription>
            <Trans>Send a reminder now or schedule it for later.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form aria-busy={isBusy} onSubmit={handleSubmit(onFormSubmit)}>
            <fieldset disabled={isBusy}>
              <FormField
                control={form.control}
                name="recipients"
                render={({ field: { value, onChange } }) => (
                  <FormItem>
                    <p className="px-3 text-muted-foreground text-xs">
                      <Trans>Select each recipient who should receive this reminder.</Trans>
                    </p>

                    <div>
                      {recipients
                        .filter((recipient) => recipient.signingStatus === SigningStatus.NOT_SIGNED)
                        .map((recipient) => {
                          const scheduledReminderAt = scheduledReminderDates[recipient.id];

                          return (
                            <FormItem
                              key={recipient.id}
                              className="flex flex-row items-center justify-between gap-x-3 px-3"
                            >
                              <div className="my-2 min-w-0">
                                <FormLabel
                                  className={cn('flex items-center gap-2 font-normal', {
                                    'opacity-50': !value.includes(recipient.id),
                                  })}
                                >
                                  <StackAvatar
                                    key={recipient.id}
                                    type={getRecipientType(recipient)}
                                    fallbackText={recipientAbbreviation(recipient)}
                                  />
                                  <span className="truncate">{recipient.email}</span>
                                </FormLabel>

                                {scheduledReminderAt && (
                                  <div className="mt-1 ml-10 flex items-center gap-1.5 text-muted-foreground text-xs">
                                    <CalendarClockIcon className="h-3.5 w-3.5" />
                                    <span>
                                      {new Intl.DateTimeFormat(undefined, {
                                        dateStyle: 'medium',
                                        timeStyle: 'short',
                                      }).format(scheduledReminderAt)}
                                      {` (${localTimeZone})`}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-1.5"
                                      disabled={isUpdatingReminderSchedule}
                                      onClick={() => void onCancelScheduledReminder(recipient.id)}
                                    >
                                      <XIcon className="mr-1 h-3 w-3" />
                                      <Trans>Cancel schedule</Trans>
                                    </Button>
                                  </div>
                                )}
                              </div>

                              <FormControl>
                                <Checkbox
                                  className="h-5 w-5"
                                  value={recipient.id}
                                  checked={value.includes(recipient.id)}
                                  onCheckedChange={(checked: boolean) =>
                                    checked
                                      ? onChange([...value, recipient.id])
                                      : onChange(value.filter((v) => v !== recipient.id))
                                  }
                                />
                              </FormControl>
                            </FormItem>
                          );
                        })}
                    </div>

                    <FormMessage className="px-3" aria-live="polite" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="delivery"
                render={({ field }) => (
                  <FormItem className="mt-4 rounded-md border p-3">
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-3">
                        <FormLabel className="flex cursor-pointer items-center gap-2 font-normal">
                          <RadioGroupItem value="now" />
                          <Trans>Send reminder now</Trans>
                        </FormLabel>
                        <FormLabel className="flex cursor-pointer items-center gap-2 font-normal">
                          <RadioGroupItem value="scheduled" />
                          <Trans>Schedule for later</Trans>
                        </FormLabel>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />

              {delivery === 'scheduled' && (
                <FormField
                  control={form.control}
                  name="scheduledAt"
                  render={({ field }) => (
                    <FormItem className="mt-3">
                      <FormLabel>
                        <Trans>Reminder date and time</Trans>
                      </FormLabel>
                      <FormControl>
                        <Input type="datetime-local" min={toLocalDateTimeInputValue(new Date())} {...field} />
                      </FormControl>
                      <p className="text-muted-foreground text-xs">
                        <Trans>
                          Times use {localTimeZone}. Delivery runs every 5 minutes, so the email may arrive shortly
                          after this time.
                        </Trans>
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {isBusy && (
                <div
                  className="mt-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-muted-foreground text-sm"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2Icon className="h-4 w-4 shrink-0 animate-spin" />
                  <span>
                    {delivery === 'scheduled' ? (
                      <Trans>Saving reminder schedule...</Trans>
                    ) : (
                      <Trans>Sending reminder...</Trans>
                    )}
                  </span>
                </div>
              )}

              <DialogFooter className="mt-4">
                <DialogClose asChild>
                  <Button type="button" variant="secondary" disabled={isBusy}>
                    <Trans>Cancel</Trans>
                  </Button>
                </DialogClose>

                <Button loading={isBusy} type="submit">
                  {isBusy ? (
                    delivery === 'scheduled' ? (
                      <Trans>Scheduling...</Trans>
                    ) : (
                      <Trans>Sending...</Trans>
                    )
                  ) : delivery === 'scheduled' ? (
                    <Trans>Schedule reminder</Trans>
                  ) : (
                    <Trans>Send reminder</Trans>
                  )}
                </Button>
              </DialogFooter>
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

const toLocalDateTimeInputValue = (date: Date): string => {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return localDate.toISOString().slice(0, 16);
};
