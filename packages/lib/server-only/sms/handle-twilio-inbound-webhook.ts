import { prisma } from '@documenso/prisma';

import { classifySmsKeyword, DEFAULT_SMS_COPY, normalisePhoneNumber } from '../../constants/sms-delivery';
import { getTeamSmsCredentials } from './sms-credentials';
import { suppressPhone } from './sms-opt-out';
import { buildTwilioInboundWebhookUrl } from './twilio-webhook-urls';
import { verifyTwilioSignature } from './verify-twilio-signature';

const MAX_TWILIO_WEBHOOK_BYTES = 16 * 1024;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const twimlResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });

const messageTwiml = (message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;

export const handleTwilioInboundWebhook = async (request: Request, teamId: number): Promise<Response> => {
  // Credentials are per team because each business verifies its own Twilio
  // account, so the token to verify against is decided by the URL the request
  // arrived on, not by a single global secret.
  const credentials = await getTeamSmsCredentials(teamId);

  if (!credentials) {
    return new Response('Webhook unavailable', { status: 503 });
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');

  if (Number.isFinite(contentLength) && contentLength > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const rawBody = await request.text();

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_TWILIO_WEBHOOK_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  // Built from configuration, never request.url: the reverse proxy rewrites the
  // host, and Twilio signed the public URL.
  const url = buildTwilioInboundWebhookUrl(teamId);

  const isValid = verifyTwilioSignature({
    url,
    params,
    authToken: credentials.authToken,
    signature: request.headers.get('x-twilio-signature'),
  });

  if (!isValid) {
    return new Response('Invalid signature', { status: 403 });
  }

  const keyword = classifySmsKeyword(params.Body ?? '');

  if (keyword === 'OTHER') {
    return twimlResponse(EMPTY_TWIML);
  }

  if (keyword === 'STOP') {
    await suppressPhone({ phone: params.From ?? '', teamId, reason: 'STOP' });

    // Twilio's own opt-out confirmation already went out. A second message
    // would text someone who just asked us to stop.
    return twimlResponse(EMPTY_TWIML);
  }

  if (keyword === 'START') {
    // Normalise on read as well as write. suppressPhone stores E.164, so
    // deleting by a raw provider value would silently fail to lift the
    // suppression if Twilio ever changed its formatting.
    const phone = normalisePhoneNumber(params.From ?? '');

    if (phone) {
      await prisma.smsOptOut.deleteMany({ where: { phone, teamId } });
    }

    return twimlResponse(EMPTY_TWIML);
  }

  // An inbound message gives us a phone number and nothing else, so there is no
  // recipient locale to resolve here. The default copy is deliberate, not an
  // oversight, and swapping it is a one-line change if that ever matters.
  return twimlResponse(messageTwiml(DEFAULT_SMS_COPY.helpReply));
};
