import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildTwilioSignature, verifyTwilioSignature } from './verify-twilio-signature';

const authToken = 'test_auth_token';
const url = 'https://documenso.lanihost.com/api/twilio/inbound-webhook';

describe('buildTwilioSignature', () => {
  it('matches the documented twilio algorithm', () => {
    const params = { To: '+18327775620', From: '+18325551234', Body: 'STOP' };

    // Reference implementation: url + each key/value in sorted key order.
    const expected = createHmac('sha1', authToken)
      .update(`${url}Body${params.Body}From${params.From}To${params.To}`)
      .digest('base64');

    expect(buildTwilioSignature({ url, params, authToken })).toBe(expected);
  });

  it('is order independent because parameters are sorted', () => {
    const a = buildTwilioSignature({ url, params: { b: '2', a: '1' }, authToken });
    const b = buildTwilioSignature({ url, params: { a: '1', b: '2' }, authToken });

    expect(a).toBe(b);
  });
});

describe('verifyTwilioSignature', () => {
  const params = { To: '+18327775620', From: '+18325551234', Body: 'STOP' };
  const signature = buildTwilioSignature({ url, params, authToken });

  it('accepts a correct signature', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature })).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyTwilioSignature({
        url,
        params: { ...params, Body: 'START' },
        authToken,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a signature built for a different url', () => {
    expect(
      verifyTwilioSignature({
        url: 'https://evil.example.com/api/twilio/inbound-webhook',
        params,
        authToken,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature: null })).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifyTwilioSignature({ url, params, authToken, signature: 'not base64!!' })).toBe(false);
  });
});
