import { describe, expect, it } from 'vitest';

import {
  buildCompletionSms,
  buildSigningRequestSms,
  classifySmsKeyword,
  getSmsSegmentCount,
  isTwilioErrorTerminal,
  isTwilioOptOutError,
  mapTwilioMessageStatus,
  normalisePhoneNumber,
  SmsSendError,
} from './sms-delivery';

describe('normalisePhoneNumber', () => {
  it.each([
    ['8325551234', '+18325551234'],
    ['(832) 555-1234', '+18325551234'],
    ['832-555-1234', '+18325551234'],
    ['18325551234', '+18325551234'],
    ['+1 832 555 1234', '+18325551234'],
    ['  +18325551234  ', '+18325551234'],
    ['+442071838750', '+442071838750'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalisePhoneNumber(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['abc'], ['555'], ['+0123456789'], ['+1234567890123456']])('rejects %s', (input) => {
    expect(normalisePhoneNumber(input)).toBeNull();
  });

  it('honours a non-US default country code', () => {
    expect(normalisePhoneNumber('2071838750', '44')).toBe('+442071838750');
  });
});

describe('twilio error classification', () => {
  it.each([
    [21211, 'invalid to number'],
    [21610, 'unsubscribed recipient'],
    [21612, 'unroutable number'],
    [21614, 'not a mobile number'],
    [30003, 'unreachable handset'],
    [30006, 'landline or unreachable carrier'],
  ])('treats twilio code %i as terminal', (code) => {
    expect(isTwilioErrorTerminal(new SmsSendError('failed', { code, status: 400 }))).toBe(true);
  });

  it.each([
    [20429, 429],
    [20500, 500],
    [20503, 503],
  ])('treats twilio code %i as retryable', (code, status) => {
    expect(isTwilioErrorTerminal(new SmsSendError('failed', { code, status }))).toBe(false);
  });

  it('treats a network error as retryable', () => {
    expect(isTwilioErrorTerminal(new Error('socket hang up'))).toBe(false);
  });

  it('identifies only code 21610 as an opt-out', () => {
    expect(isTwilioOptOutError(new SmsSendError('stop', { code: 21610, status: 400 }))).toBe(true);
    expect(isTwilioOptOutError(new SmsSendError('bad', { code: 21211, status: 400 }))).toBe(false);
    expect(isTwilioOptOutError(new Error('socket hang up'))).toBe(false);
  });
});

describe('sms message bodies', () => {
  it('builds a signing request containing the brand and link', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: false,
    });

    expect(body).toContain('EverTrade');
    expect(body).toContain('https://documenso.lanihost.com/sign/abc123');
    expect(body).not.toContain('STOP');
  });

  it('appends the opt-out notice on a first message', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: true,
    });

    expect(body).toContain('Reply STOP to opt out');
  });

  it('builds a completion message naming the document', () => {
    const body = buildCompletionSms({
      brandLabel: 'EverTrade',
      documentTitle: 'Introductory Employment Agreement',
      includeOptOutNotice: false,
    });

    expect(body).toContain('Introductory Employment Agreement');
    expect(body).toContain('EverTrade');
  });

  it('keeps a typical signing request to one segment', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: false,
    });

    expect(getSmsSegmentCount(body)).toBe(1);
  });

  it.each([
    ['a'.repeat(160), 1],
    ['a'.repeat(161), 2],
    ['a'.repeat(306), 2],
    ['a'.repeat(307), 3],
  ])('counts a gsm body of length %s correctly', (body, expected) => {
    expect(getSmsSegmentCount(body)).toBe(expected);
  });

  it.each([
    ['中'.repeat(70), 1],
    ['中'.repeat(71), 2],
  ])('counts a non-gsm body using the 70-character limit', (body, expected) => {
    expect(getSmsSegmentCount(body)).toBe(expected);
  });

  it('still counts accented latin as gsm, not unicode', () => {
    expect(getSmsSegmentCount('é'.repeat(100))).toBe(1);
  });
});

describe('classifySmsKeyword', () => {
  it.each([
    ['STOP'],
    ['stop'],
    ['  Stop  '],
    ['STOPALL'],
    ['UNSUBSCRIBE'],
    ['CANCEL'],
    ['END'],
    ['QUIT'],
  ])('classifies %s as STOP', (body) => {
    expect(classifySmsKeyword(body)).toBe('STOP');
  });

  it.each([['START'], ['start'], ['YES'], ['UNSTOP']])('classifies %s as START', (body) => {
    expect(classifySmsKeyword(body)).toBe('START');
  });

  it.each([['HELP'], ['help'], ['INFO']])('classifies %s as HELP', (body) => {
    expect(classifySmsKeyword(body)).toBe('HELP');
  });

  it.each([[''], ['thanks'], ['please stop sending me documents'], ['stop it']])('classifies %s as OTHER', (body) => {
    expect(classifySmsKeyword(body)).toBe('OTHER');
  });
});

describe('mapTwilioMessageStatus', () => {
  it.each([
    ['queued', 'SUBMITTED'],
    ['accepted', 'SUBMITTED'],
    ['scheduled', 'SUBMITTED'],
    ['sending', 'SUBMITTED'],
    ['sent', 'SUBMITTED'],
    ['delivered', 'DELIVERED'],
    ['undelivered', 'BOUNCED'],
    ['failed', 'FAILED'],
  ])('maps %s to %s', (status, expected) => {
    expect(mapTwilioMessageStatus(status)).toBe(expected);
  });

  it('is case insensitive', () => {
    expect(mapTwilioMessageStatus('DELIVERED')).toBe('DELIVERED');
  });

  it.each([['read'], ['partially_delivered'], ['']])('ignores %s', (status) => {
    expect(mapTwilioMessageStatus(status)).toBeNull();
  });
});

describe('injectable sms copy', () => {
  const spanish = {
    optOutNotice: 'Responda STOP para cancelar.',
    signingRequest: ({ brandLabel, signingUrl }: { brandLabel: string; signingUrl: string }) =>
      `${brandLabel}: tiene un documento para firmar. ${signingUrl}`,
    completion: ({ brandLabel }: { brandLabel: string; documentTitle: string }) => `${brandLabel}: firmado.`,
    helpReply: 'Ayuda',
  };

  it('uses supplied copy instead of the english default', () => {
    const body = buildSigningRequestSms({
      brandLabel: 'EverTrade',
      signingUrl: 'https://documenso.lanihost.com/sign/abc123',
      includeOptOutNotice: true,
      copy: spanish,
    });

    expect(body).toContain('tiene un documento para firmar');
    expect(body).toContain('Responda STOP para cancelar.');
    expect(body).not.toContain('Reply STOP');
  });

  it('falls back to the english default when no copy is supplied', () => {
    const body = buildCompletionSms({
      brandLabel: 'EverTrade',
      documentTitle: 'Agreement',
      includeOptOutNotice: false,
    });

    expect(body).toContain('is fully signed');
  });
});
