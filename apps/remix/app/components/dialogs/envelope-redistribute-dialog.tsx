import { getRecipientType } from '@documenso/lib/client-only/recipient-type';
import { getScheduledReminderSequenceDates } from '@documenso/lib/constants/scheduled-reminder-delivery';
import { normalisePhoneNumber } from '@documenso/lib/constants/sms-delivery';
import { AppError } from '@documenso/lib/errors/app-error';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import type { TEnvelopeRecipientLite } from '@documenso/lib/types/recipient';
import { ZRecipientPhoneSchema } from '@documenso/lib/types/recipient-phone';
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
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';
import { CalendarClockIcon, Loader2Icon, XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { match } from 'ts-pattern';
import * as z from 'zod';
import { useOptionalCurrentTeam } from '~/providers/team';
import { getDistributeErrorMessage } from '~/utils/toast-error-messages';
import { StackAvatar } from '../general/stack-avatar';

export type EnvelopeRedistributeDialogProps = {
  envelope: Pick<TEnvelope, 'id' | 'status' | 'type'> & {
    recipients: TEnvelopeRecipientLite[];
    documentMeta?: { smsEnabled?: boolean | null } | null;
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
    scheduleType: z.enum(['one', 'sequence']),
    intervalDays: z.number().int().min(1).max(30),
    total: z.number().int().min(1).max(5),
    smsEnabled: z.boolean(),
    recipientPhones: z.record(z.string()),
  })
  .superRefine((value, context) => {
    for (const recipientId of value.recipients) {
      const phone = value.recipientPhones[`recipient_${recipientId}`] ?? '';
      if (!ZRecipientPhoneSchema.safeParse(phone).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: msg`Enter a valid mobile number. Include a country code outside the US or Canada.`.id,
          path: ['recipientPhones', `recipient_${recipientId}`],
        });
      }
    }

    if (
      value.smsEnabled &&
      !value.recipients.some((id) => normalisePhoneNumber(value.recipientPhones[`recipient_${id}`] ?? ''))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg`Add a mobile number for a selected recipient, or turn off text messages.`.id,
        path: ['smsEnabled'],
      });
    }

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

    if (value.scheduleType === 'sequence' && value.total < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg`A reminder sequence needs at least two reminders`.id,
        path: ['total'],
      });
    }
  });

export type TEnvelopeRedistributeFormSchema = z.infer<typeof ZEnvelopeRedistributeFormSchema>;

export const EnvelopeRedistributeDialog = ({ envelope, envelopeType, trigger }: EnvelopeRedistributeDialogProps) => {
  const recipients = envelope.recipients;
  const formId = useId();

  const { toast } = useToast();
  const { t, i18n } = useLingui();
  const trpcUtils = trpcReact.useUtils();
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [isOpen, setIsOpen] = useState(false);
  const [scheduledReminderDates, setScheduledReminderDates] = useState<Record<number, Date | null>>({});

  const { mutateAsync: redistributeEnvelope } = trpcReact.envelope.redistribute.useMutation();

  const currentTeam = useOptionalCurrentTeam();
  const smsDefaultOn = currentTeam?.preferences?.smsDefaultOn ?? false;
  const smsAvailable = currentTeam?.preferences?.smsAvailable ?? false;
  const { mutateAsync: updateReminderSchedule, isPending: isUpdatingReminderSchedule } =
    trpcReact.envelope.reminderSchedule.update.useMutation();

  const form = useForm<TEnvelopeRedistributeFormSchema>({
    defaultValues: {
      recipients: [],
      smsEnabled: smsAvailable && (envelope.documentMeta?.smsEnabled ?? smsDefaultOn),
      recipientPhones: Object.fromEntries(
        recipients.map((recipient) => [`recipient_${recipient.id}`, recipient.phone ?? '']),
      ),
      delivery: 'now',
      scheduledAt: '',
      scheduleType: 'one',
      intervalDays: 3,
      total: 4,
    },
    resolver: zodResolver(ZEnvelopeRedistributeFormSchema),
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = form;

  const selectedRecipientIds = form.watch('recipients');
  const recipientPhones = form.watch('recipientPhones');
  const smsEnabled = form.watch('smsEnabled');
  const smsRecipientCount = selectedRecipientIds.filter((id) =>
    normalisePhoneNumber(recipientPhones[`recipient_${id}`] ?? ''),
  ).length;
  const delivery = form.watch('delivery');
  const scheduleType = form.watch('scheduleType');
  const scheduledAt = form.watch('scheduledAt');
  const intervalDays = form.watch('intervalDays');
  const total = form.watch('total');
  const isBusy = isSubmitting || isUpdatingReminderSchedule;

  const refreshReminderData = async () => {
    await Promise.allSettled([
      trpcUtils.document.findDocumentsInternal.invalidate(),
      trpcUtils.document.auditLog.find.invalidate(),
      trpcUtils.envelope.get.invalidate(),
    ]);
  };

  const onFormSubmit = async ({
    recipients,
    delivery,
    scheduledAt,
    scheduleType,
    intervalDays,
    total,
    smsEnabled,
    recipientPhones,
  }: TEnvelopeRedistributeFormSchema) => {
    try {
      const phoneUpdates = recipients.map((id) => ({ id, phone: recipientPhones[`recipient_${id}`] ?? '' }));
      if (delivery === 'scheduled') {
        const response = await updateReminderSchedule({
          envelopeId: envelope.id,
          recipients,
          scheduledAt: new Date(scheduledAt),
          timezone: localTimeZone,
          recipientPhones: phoneUpdates,
          smsEnabled: smsAvailable ? smsEnabled : undefined,
          total: scheduleType === 'sequence' ? total : 1,
          intervalDays: scheduleType === 'sequence' ? intervalDays : null,
        });

        setScheduledReminderDates((current) => ({
          ...current,
          ...Object.fromEntries(response.recipients.map((recipient) => [recipient.id, recipient.scheduledReminderAt])),
        }));

        await refreshReminderData();

        const formattedScheduledAt = new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(scheduledAt));

        toast({
          title: scheduleType === 'sequence' ? t`Reminder sequence scheduled` : t`Reminder scheduled`,
          description:
            scheduleType === 'sequence'
              ? t`${total} reminders will start ${formattedScheduledAt} (${localTimeZone}).`
              : t`Reminder set for ${formattedScheduledAt} (${localTimeZone}).`,
          duration: 5000,
        });

        setIsOpen(false);
        return;
      }

      await redistributeEnvelope({
        envelopeId: envelope.id,
        recipients,
        smsEnabled: smsAvailable ? smsEnabled : undefined,
        recipientPhones: phoneUpdates,
      });
      await refreshReminderData();

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
        description: t`The recipient will not receive the remaining scheduled reminders.`,
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

    form.reset({
      ...form.getValues(),
      smsEnabled: smsAvailable && (envelope.documentMeta?.smsEnabled ?? smsDefaultOn),
      recipientPhones: Object.fromEntries(
        recipients.map((recipient) => [`recipient_${recipient.id}`, recipient.phone ?? '']),
      ),
    });

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

      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" hideClose>
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
                        .filter(
                          (recipient) =>
                            recipient.signingStatus === SigningStatus.NOT_SIGNED && recipient.role !== RecipientRole.CC,
                        )
                        .map((recipient) => {
                          const scheduledReminderAt = scheduledReminderDates[recipient.id];

                          return (
                            <FormItem key={recipient.id} className="space-y-2 px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
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
                                    className="h-5 w-5 shrink-0"
                                    aria-label={t`Send reminder to ${recipient.email}`}
                                    value={recipient.id}
                                    checked={value.includes(recipient.id)}
                                    onCheckedChange={(checked: boolean) =>
                                      checked
                                        ? onChange([...value, recipient.id])
                                        : onChange(value.filter((v) => v !== recipient.id))
                                    }
                                  />
                                </FormControl>
                              </div>

                              {value.includes(recipient.id) && (
                                <FormField
                                  control={form.control}
                                  name={`recipientPhones.recipient_${recipient.id}`}
                                  render={({ field }) => (
                                    <FormItem className="pl-10">
                                      <FormLabel className="text-xs">
                                        <Trans>Mobile number (optional)</Trans>
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          {...field}
                                          value={field.value ?? ''}
                                          type="tel"
                                          onChange={(event) => {
                                            field.onChange(event);
                                            if (form.formState.isSubmitted) {
                                              void form.trigger('smsEnabled');
                                            }
                                          }}
                                          autoComplete="tel"
                                          placeholder={t`e.g. (832) 555-0123`}
                                          maxLength={30}
                                        />
                                      </FormControl>
                                      <p className="text-muted-foreground text-xs">
                                        {smsEnabled && normalisePhoneNumber(field.value ?? '') ? (
                                          <Trans>Email + SMS to {normalisePhoneNumber(field.value ?? '')}</Trans>
                                        ) : (
                                          <Trans>
                                            Email only. Add a mobile number and enable text messages for SMS.
                                          </Trans>
                                        )}
                                      </p>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                              )}
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
                name="smsEnabled"
                render={({ field }) => (
                  <FormItem className="mt-4 flex flex-row items-start gap-2 space-y-0 rounded-md border p-3">
                    <FormControl>
                      <Checkbox
                        disabled={!smsAvailable}
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    </FormControl>

                    <div className="space-y-1">
                      <FormLabel className="font-normal">
                        <Trans>Also send a text message</Trans>
                      </FormLabel>

                      {!smsAvailable && (
                        <p className="text-muted-foreground text-xs" role="status">
                          <Trans>Text messages are off for this team. This reminder will use email only.</Trans>{' '}
                          {currentTeam && (
                            <Link
                              className="font-medium text-primary underline underline-offset-4"
                              to={`/t/${currentTeam.url}/settings/document`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Trans>Set up SMS</Trans>
                            </Link>
                          )}
                        </p>
                      )}
                      <p className="text-muted-foreground text-xs">
                        {smsEnabled && smsRecipientCount > 0 ? (
                          plural(smsRecipientCount, {
                            one: 'SMS enabled for # selected recipient. Others receive email only.',
                            other: 'SMS enabled for # selected recipients. Others receive email only.',
                          })
                        ) : (
                          <Trans>
                            Add a mobile number under each selected recipient. Numbers are saved with this reminder.
                          </Trans>
                        )}
                      </p>
                      <FormMessage />
                    </div>
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
                        <FormLabel
                          htmlFor={`${formId}-now`}
                          className="flex cursor-pointer items-center gap-2 font-normal"
                        >
                          <RadioGroupItem id={`${formId}-now`} value="now" />
                          <Trans>Send reminder now</Trans>
                        </FormLabel>
                        <FormLabel
                          htmlFor={`${formId}-scheduled`}
                          className="flex cursor-pointer items-center gap-2 font-normal"
                        >
                          <RadioGroupItem id={`${formId}-scheduled`} value="scheduled" />
                          <Trans>Schedule for later</Trans>
                        </FormLabel>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />

              {delivery === 'scheduled' && (
                <div className="mt-3 space-y-3">
                  <FormField
                    control={form.control}
                    name="scheduleType"
                    render={({ field }) => (
                      <FormItem className="rounded-md border p-1">
                        <FormControl>
                          <RadioGroup
                            value={field.value}
                            onValueChange={field.onChange}
                            className="grid grid-cols-2 gap-1"
                          >
                            <FormLabel
                              htmlFor={`${formId}-one`}
                              className={cn('cursor-pointer rounded px-3 py-2 text-center font-normal', {
                                'border border-primary text-primary': field.value === 'one',
                              })}
                            >
                              <RadioGroupItem id={`${formId}-one`} value="one" className="sr-only" />
                              <Trans>One reminder</Trans>
                            </FormLabel>
                            <FormLabel
                              htmlFor={`${formId}-sequence`}
                              className={cn('cursor-pointer rounded px-3 py-2 text-center font-normal', {
                                'border border-primary text-primary': field.value === 'sequence',
                              })}
                            >
                              <RadioGroupItem id={`${formId}-sequence`} value="sequence" className="sr-only" />
                              <Trans>Reminder sequence</Trans>
                            </FormLabel>
                          </RadioGroup>
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="scheduledAt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <Trans>First reminder</Trans>
                        </FormLabel>
                        <FormControl>
                          <Input type="datetime-local" min={toLocalDateTimeInputValue(new Date())} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormItem>
                    <FormLabel>
                      <Trans>Timezone</Trans>
                    </FormLabel>
                    <Input value={localTimeZone} readOnly aria-label={t`Timezone`} />
                  </FormItem>

                  {scheduleType === 'sequence' && (
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="intervalDays"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              <Trans>Repeat every (days)</Trans>
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={1}
                                max={30}
                                value={field.value}
                                onChange={(event) => field.onChange(Number(event.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="total"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              <Trans>Total reminders</Trans>
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={2}
                                max={5}
                                value={field.value}
                                onChange={(event) => field.onChange(Number(event.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}

                  {scheduledAt && (
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      <p className="font-medium">
                        <Trans>Next deliveries</Trans>
                      </p>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {formatSequencePreview({
                          scheduledAt,
                          timezone: localTimeZone,
                          total: scheduleType === 'sequence' ? total : 1,
                          intervalDays: scheduleType === 'sequence' ? intervalDays : null,
                        })}
                      </p>
                    </div>
                  )}

                  <div className="rounded-md border px-3 py-2 text-muted-foreground text-xs">
                    <Trans>
                      Reminders stop automatically when the recipient signs or the document completes, expires, or is
                      cancelled.
                    </Trans>
                  </div>

                  <p className="text-muted-foreground text-xs">
                    <Trans>Maximum 5 reminders. Delivery runs every 5 minutes.</Trans>
                  </p>
                </div>
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

const formatSequencePreview = (options: {
  scheduledAt: string;
  timezone: string;
  total: number;
  intervalDays: number | null;
}) => {
  try {
    return getScheduledReminderSequenceDates({
      scheduledAt: new Date(options.scheduledAt),
      timezone: options.timezone,
      total: options.total,
      intervalDays: options.intervalDays,
    })
      .map((date) =>
        new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: options.timezone,
        }).format(date),
      )
      .join(', ');
  } catch {
    return '';
  }
};
