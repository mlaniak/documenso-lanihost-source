import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio signs the full public request URL followed by every POST parameter in
 * sorted key order, concatenated as key + value with no separator, using
 * HMAC-SHA1 keyed with the account auth token.
 */
export const buildTwilioSignature = (options: {
  url: string;
  params: Record<string, string>;
  authToken: string;
}): string => {
  const payload = Object.keys(options.params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${options.params[key]}`, options.url);

  return createHmac('sha1', options.authToken).update(payload).digest('base64');
};

export const verifyTwilioSignature = (options: {
  url: string;
  params: Record<string, string>;
  authToken: string;
  signature: string | null;
}): boolean => {
  if (!options.signature) {
    return false;
  }

  const expected = buildTwilioSignature(options);
  const expectedBuffer = Buffer.from(expected, 'base64');
  const providedBuffer = Buffer.from(options.signature, 'base64');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
};
