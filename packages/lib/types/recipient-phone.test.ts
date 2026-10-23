import { describe, expect, it } from 'vitest';
import { ZRecipientPhoneSchema } from './recipient-phone';

describe('recipient mobile input', () => {
  it.each(['', '  ', '(832) 555-0123', '+44 7700 900123', '+1 (832) 555-0123'])('accepts %j', (phone) => {
    expect(ZRecipientPhoneSchema.safeParse(phone).success).toBe(true);
  });
  it.each([
    '555',
    'abc8325550123',
    '+0123456789',
    '8325550123 ext 4',
    '1234567890123456789012345678901',
  ])('rejects %j', (phone) => {
    expect(ZRecipientPhoneSchema.safeParse(phone).success).toBe(false);
  });
});
