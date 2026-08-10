import { env } from '../../utils/env';

/**
 * Webhook URLs carry the team id because signature verification needs the
 * sending account's auth token, and with one Twilio account per business there
 * is no single global token to verify against. Attributing the request by URL
 * is unambiguous; guessing from the payload is not.
 */
export const buildTwilioInboundWebhookPath = (teamId: number): string => `/api/twilio/inbound-webhook/${teamId}`;

export const buildTwilioStatusWebhookPath = (teamId: number): string => `/api/twilio/status-webhook/${teamId}`;

const buildPublicUrl = (path: string): string => `${env('NEXT_PUBLIC_WEBAPP_URL') ?? ''}${path}`;

/**
 * Built from configuration, never from an incoming request URL: the reverse
 * proxy rewrites the host, and Twilio signed the public URL.
 */
export const buildTwilioInboundWebhookUrl = (teamId: number): string =>
  buildPublicUrl(buildTwilioInboundWebhookPath(teamId));

export const buildTwilioStatusCallbackUrl = (teamId: number): string =>
  buildPublicUrl(buildTwilioStatusWebhookPath(teamId));
