import { createHash } from 'node:crypto';

import { prisma } from '@documenso/prisma';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  type DocumentNotificationSettings,
  parseDocumentNotificationSettings,
} from '../../types/document-notification-settings';
import { parseSmsSettings, type TSmsSettings } from '../../types/sms-settings';
import { sendSms } from '../sms/send-sms';
import { resolveSmsCredentials } from '../sms/sms-credentials';
import { getTeamSettings } from '../team/get-team-settings';
import { sendNtfy } from './send-ntfy';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Route = { channel: 'SMS' | 'NTFY'; destination: string; key: string };

/** Route fingerprints cancel queued work if a destination/account is changed. */
export const getNotificationRoutes = (options: {
  settings: DocumentNotificationSettings;
  sms: TSmsSettings;
  audience: 'SIGNER' | 'STAFF';
  event: string;
  email?: string;
}): Route[] => {
  const { settings, sms, audience, event, email } = options;
  const routes: Route[] = [];
  const addPush = (destination: string) => {
    if (settings.ntfy.token && /^[A-Za-z0-9_-]{1,128}$/.test(destination)) {
      routes.push({ channel: 'NTFY', destination, key: hash(`NTFY:${settings.ntfy.serverUrl}:${destination}`) });
    }
  };
  if (audience === 'SIGNER') {
    if (settings.signers.ntfyEnabled) {
      const target = settings.signers.targets.find((target) => target.email === email?.trim().toLowerCase());
      if (target) {
        addPush(target.topic);
      }
    }
    return routes;
  }
  if (!settings.staff.events.some((value) => value === event)) {
    return routes;
  }
  if (settings.staff.ntfyEnabled) {
    addPush(settings.staff.topic);
  }
  if (settings.staff.smsEnabled && sms.accountSid && sms.authToken) {
    for (const phone of new Set(settings.staff.phones)) {
      routes.push({
        channel: 'SMS',
        destination: phone,
        key: hash(`SMS:${sms.accountSid}:${sms.senderNumber}:${phone}`),
      });
    }
  }
  return routes;
};

export const enqueueDocumentNotification = async (options: {
  envelopeId: string;
  teamId: number;
  audience: 'SIGNER' | 'STAFF';
  event: string;
  recipientId?: number;
  occurrence?: string;
  scheduledAt?: Date;
}) => {
  const derived = await getTeamSettings({ teamId: options.teamId });
  const recipient = options.recipientId
    ? await prisma.recipient.findUnique({
        where: { id: options.recipientId, envelopeId: options.envelopeId },
        select: { email: true },
      })
    : null;
  if (options.audience === 'SIGNER' && !recipient) {
    return;
  }
  const routes = getNotificationRoutes({
    settings: parseDocumentNotificationSettings(derived.notificationSettings),
    sms: parseSmsSettings(derived.smsSettings),
    audience: options.audience,
    event: options.event,
    email: recipient?.email,
  });
  for (const route of routes) {
    const id = hash(
      [
        options.envelopeId,
        options.audience,
        options.event,
        options.recipientId ?? '',
        options.occurrence ?? '',
        route.key,
      ].join(':'),
    );
    await prisma.documentNotificationDelivery.upsert({
      where: { id },
      update: {},
      create: {
        id,
        envelopeId: options.envelopeId,
        recipientId: options.recipientId,
        audience: options.audience,
        channel: route.channel,
        event: options.event,
        routeKey: route.key,
        nextAttemptAt: options.scheduledAt ?? new Date(),
      },
    });
  }
};

/** Called by lifecycle webhook dispatch, independently of registered webhooks. */
export const enqueueStaffDocumentNotification = async (options: {
  event: string;
  data: Record<string, unknown>;
  teamId: number;
  recipientId?: number;
}) => {
  if (!['DOCUMENT_SIGNED', 'DOCUMENT_COMPLETED'].includes(options.event)) {
    return;
  }
  const envelopeId = options.data.envelopeId;
  if (typeof envelopeId !== 'string') {
    return;
  }
  const envelope = await prisma.envelope.findFirst({
    where: { id: envelopeId, teamId: options.teamId, deletedAt: null },
  });
  if (!envelope) {
    return;
  }
  if (options.event === 'DOCUMENT_COMPLETED') {
    const recipients = await prisma.recipient.findMany({
      where: { envelopeId, role: { not: 'CC' } },
      select: { id: true },
    });
    for (const recipient of recipients) {
      await enqueueDocumentNotification({
        envelopeId,
        teamId: options.teamId,
        audience: 'SIGNER',
        event: 'COMPLETION',
        recipientId: recipient.id,
      });
    }
  }
  // For signed events, use signed recipient IDs/timestamps from the database,
  // not untrusted webhook bodies. Upserts suppress already-notified signatures.
  if (options.event === 'DOCUMENT_SIGNED' && options.recipientId === undefined) {
    return;
  }
  const occurrences =
    options.event === 'DOCUMENT_SIGNED'
      ? (
          await prisma.recipient.findMany({
            where: { envelopeId, id: options.recipientId, signingStatus: 'SIGNED', signedAt: { not: null } },
            select: { id: true, signedAt: true },
          })
        ).map((r) => `${r.id}:${r.signedAt?.toISOString()}`)
      : ['completed'];
  for (const occurrence of occurrences) {
    await enqueueDocumentNotification({
      envelopeId,
      teamId: options.teamId,
      audience: 'STAFF',
      event: options.event,
      occurrence,
    });
  }
};

export const processDocumentNotificationDeliveries = async () => {
  // A crashed sender may have submitted to the provider already. Surface it for
  // review rather than blindly resending a real text/push after a lost response.
  await prisma.documentNotificationDelivery.updateMany({
    where: { status: 'PROCESSING', claimedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: 'UNKNOWN', lastError: 'Sender interrupted; provider outcome requires review' },
  });
  const due = await prisma.documentNotificationDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 50,
  });
  for (const delivery of due) {
    const claim = await prisma.documentNotificationDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING' },
      data: { status: 'PROCESSING', claimedAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (!claim.count) {
      continue;
    }
    try {
      const envelope = await prisma.envelope.findUnique({
        where: { id: delivery.envelopeId },
        include: { team: { select: { url: true } }, user: { select: { disabled: true } } },
      });
      const recipient = delivery.recipientId
        ? await prisma.recipient.findUnique({ where: { id: delivery.recipientId } })
        : null;
      const isSigner = delivery.audience === 'SIGNER';
      const isPendingSigner = !['COMPLETION'].includes(delivery.event);
      if (
        !envelope ||
        envelope.deletedAt ||
        envelope.user.disabled ||
        (delivery.event === 'DOCUMENT_COMPLETED' && envelope.status !== 'COMPLETED') ||
        (isSigner &&
          (!recipient ||
            recipient.envelopeId !== envelope.id ||
            recipient.role === 'CC' ||
            (isPendingSigner &&
              (envelope.status !== 'PENDING' ||
                recipient.signingStatus !== 'NOT_SIGNED' ||
                (recipient.expiresAt && recipient.expiresAt <= new Date()))) ||
            (!isPendingSigner && envelope.status !== 'COMPLETED')))
      ) {
        await prisma.documentNotificationDelivery.update({
          where: { id: delivery.id },
          data: { status: 'CANCELLED', claimedAt: null },
        });
        continue;
      }
      if (isSigner && delivery.event === 'REMINDER') {
        const source = await prisma.scheduledReminderDelivery.findFirst({
          where: {
            envelopeId: envelope.id,
            recipientId: delivery.recipientId ?? undefined,
            scheduledAt: delivery.nextAttemptAt,
            kind: 'REMINDER',
            status: { in: ['PENDING', 'PROCESSING', 'SENT'] },
          },
          select: { id: true },
        });
        if (!source) {
          await prisma.documentNotificationDelivery.update({
            where: { id: delivery.id },
            data: { status: 'CANCELLED', claimedAt: null },
          });
          continue;
        }
      }
      const derived = await getTeamSettings({ teamId: envelope.teamId });
      const settings = parseDocumentNotificationSettings(derived.notificationSettings);
      const sms = parseSmsSettings(derived.smsSettings);
      const route = getNotificationRoutes({
        settings,
        sms,
        audience: isSigner ? 'SIGNER' : 'STAFF',
        event: delivery.event,
        email: recipient?.email,
      }).find((route) => route.key === delivery.routeKey && route.channel === delivery.channel);
      if (!route) {
        await prisma.documentNotificationDelivery.update({
          where: { id: delivery.id },
          data: { status: 'CANCELLED', claimedAt: null },
        });
        continue;
      }
      const completed = ['COMPLETION', 'DOCUMENT_COMPLETED'].includes(delivery.event);
      const title = completed
        ? 'Document completed'
        : delivery.event === 'DOCUMENT_SIGNED'
          ? 'Document signed'
          : 'Document ready to sign';
      const message = isSigner
        ? completed
          ? 'Your document is complete. The completed copy is in your email.'
          : 'A document is waiting for your action. Open your Documenso inbox or use the link in your email.'
        : completed
          ? 'A document is fully signed. Open Documenso to review.'
          : 'A recipient signed a document. Open Documenso to review.';
      // Never publish signer bearer links, names, emails or document titles.
      const click = isSigner
        ? `${NEXT_PUBLIC_WEBAPP_URL()}/inbox`
        : `${NEXT_PUBLIC_WEBAPP_URL()}/t/${encodeURIComponent(envelope.team.url)}/documents/${encodeURIComponent(envelope.id)}`;
      let providerMessageId: string | undefined;
      if (route.channel === 'NTFY' && settings.ntfy.token) {
        await sendNtfy({
          ...settings.ntfy,
          token: settings.ntfy.token,
          topic: route.destination,
          title,
          message,
          click,
        });
      } else if (route.channel === 'SMS') {
        const credentials = resolveSmsCredentials(sms);
        if (!credentials) {
          throw new AppError(AppErrorCode.NOT_SETUP, { message: 'Company Twilio credentials are unavailable' });
        }
        const result = await sendSms({
          to: route.destination,
          from: sms.senderNumber,
          body: `${sms.brandLabel}: ${message} ${click} Reply STOP to opt out.`,
          teamId: envelope.teamId,
          credentials,
        });
        if (result.status !== 'sent') {
          await prisma.documentNotificationDelivery.update({
            where: { id: delivery.id },
            data: { status: 'CANCELLED', claimedAt: null, lastError: `SMS ${result.status}` },
          });
          continue;
        }
        providerMessageId = result.providerMessageId;
      }
      await prisma.documentNotificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'ACCEPTED', claimedAt: null, acceptedAt: new Date(), providerMessageId, lastError: null },
      });
    } catch {
      // Provider response bodies may contain destinations/credentials. Keep the
      // persistent error deliberately generic. Acceptance is not device receipt.
      await prisma.documentNotificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'UNKNOWN',
          claimedAt: null,
          lastError: 'Delivery could not be confirmed; review provider logs before retrying',
        },
      });
    }
  }
};
