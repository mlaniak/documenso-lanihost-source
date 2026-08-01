import { Resend } from 'resend';

const resendWebhookVerifier = new Resend('re_webhook_verification_only');

type VerifyResendWebhookOptions = {
  payload: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  webhookSecret: string;
};

export const verifyResendWebhook = ({
  payload,
  webhookId,
  webhookTimestamp,
  webhookSignature,
  webhookSecret,
}: VerifyResendWebhookOptions): unknown =>
  resendWebhookVerifier.webhooks.verify({
    payload,
    headers: {
      id: webhookId,
      timestamp: webhookTimestamp,
      signature: webhookSignature,
    },
    webhookSecret,
  });
