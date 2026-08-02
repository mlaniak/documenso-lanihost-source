import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { parseTeamOperationsSettings } from '@documenso/lib/types/team-operations';
import { env } from '@documenso/lib/utils/env';
import { formatSigningLink } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import {
  DocumentAutomationStatus,
  DocumentAutomationType,
  DocumentStatus,
  EnvelopeType,
  SigningStatus,
} from '@prisma/client';
import { nanoid } from 'nanoid';

import { authenticatedProcedure } from '../trpc';
import { assertReminderManager } from './find-reminder-schedules';
import { ZSendSigningLinkSmsRequestSchema, ZSendSigningLinkSmsResponseSchema } from './send-signing-link-sms.types';

export const sendSigningLinkSmsRoute = authenticatedProcedure
  .input(ZSendSigningLinkSmsRequestSchema)
  .output(ZSendSigningLinkSmsResponseSchema)
  .mutation(async ({ input, ctx }) => {
    await assertReminderManager(ctx.teamId, ctx.user.id);

    const [accountSid, authToken, fromNumber] = [
      env('NEXT_PRIVATE_TWILIO_ACCOUNT_SID'),
      env('NEXT_PRIVATE_TWILIO_AUTH_TOKEN'),
      env('NEXT_PRIVATE_TWILIO_FROM_NUMBER'),
    ];

    if (!accountSid || !authToken || !fromNumber) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'SMS delivery is not configured on this server.',
        statusCode: 503,
      });
    }

    const envelope = await prisma.envelope.findFirst({
      where: {
        id: input.envelopeId,
        teamId: ctx.teamId,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.PENDING,
      },
      select: {
        id: true,
        title: true,
        team: { select: { teamGlobalSettings: { select: { operationsSettings: true } } } },
        recipients: {
          where: { id: input.recipientId },
          select: { id: true, name: true, token: true, signingStatus: true },
        },
      },
    });

    const settings = parseTeamOperationsSettings(envelope?.team.teamGlobalSettings.operationsSettings);
    const recipient = envelope?.recipients[0];

    if (!envelope || !recipient || recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
      throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Pending signer could not be found.' });
    }

    if (!settings.smsEnabled) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'SMS signing links are disabled for this team.',
        statusCode: 409,
      });
    }

    const idempotencyKey = `sms:${envelope.id}:${recipient.id}:${nanoid(16)}`;
    const phoneLast4 = input.phoneNumber.slice(-4);
    const run = await prisma.documentAutomationRun.create({
      data: {
        idempotencyKey,
        type: DocumentAutomationType.SIGNING_LINK_SMS,
        status: DocumentAutomationStatus.PROCESSING,
        provider: 'twilio',
        envelopeId: envelope.id,
        metadata: { recipientId: recipient.id, phoneLast4, consentConfirmed: true, requestedBy: ctx.user.id },
      },
    });

    try {
      const body = new URLSearchParams({
        To: input.phoneNumber,
        From: fromNumber,
        Body: `${recipient.name || 'Hello'}, please review and sign "${envelope.title}": ${formatSigningLink(recipient.token)}`,
      });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const result = (await response.json()) as { sid?: string; status?: string; message?: string };

      if (!response.ok || !result.sid) {
        throw new Error(result.message || `Twilio returned HTTP ${response.status}`);
      }

      await prisma.documentAutomationRun.update({
        where: { id: run.id },
        data: {
          status: DocumentAutomationStatus.COMPLETED,
          providerId: result.sid,
          completedAt: new Date(),
          metadata: {
            recipientId: recipient.id,
            phoneLast4,
            consentConfirmed: true,
            requestedBy: ctx.user.id,
            providerStatus: result.status || 'queued',
          },
        },
      });

      return { deliveryId: run.id, providerStatus: result.status || 'queued', phoneLast4 };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'SMS provider request failed';

      await prisma.documentAutomationRun.update({
        where: { id: run.id },
        data: { status: DocumentAutomationStatus.FAILED, error: message, completedAt: new Date() },
      });

      throw new AppError(AppErrorCode.UNKNOWN_ERROR, { message: 'The signing link could not be sent by SMS.' });
    }
  });
