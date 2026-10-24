import { describe, expect, it } from 'vitest';
import { validateReminderRecipientChannels } from './validate-reminder-recipient-channels';

const base = { recipientIds: [7], eligibleRecipients: [{ id: 7, phone: '+18325550123' }] };
describe('reminder communication methods', () => {
  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])('accepts email=%s, SMS=%s independently', (email, sms) => {
    expect(validateReminderRecipientChannels({ ...base, recipientChannels: [{ id: 7, email, sms }] }).get(7)).toEqual({
      id: 7,
      email,
      sms,
    });
  });
  it.each([
    [],
    [{ id: 7, email: false, sms: false }],
    [{ id: 8, email: true, sms: false }],
    [
      { id: 7, email: true, sms: false },
      { id: 7, email: false, sms: true },
    ],
  ])('rejects empty, unselected, unknown, or duplicate recipients', (recipientChannels) => {
    expect(() => validateReminderRecipientChannels({ ...base, recipientChannels })).toThrow();
  });
  it('rejects editing a phone when only email is selected', () => {
    expect(() =>
      validateReminderRecipientChannels({
        ...base,
        recipientChannels: [{ id: 7, email: true, sms: false }],
        recipientPhones: [{ id: 7, phone: '8325550123' }],
      }),
    ).toThrow('selected SMS');
  });
  it('requires a valid phone for SMS but ignores a stored invalid phone for email only', () => {
    const options = { ...base, eligibleRecipients: [{ id: 7, phone: 'bad' }] };
    expect(() =>
      validateReminderRecipientChannels({ ...options, recipientChannels: [{ id: 7, email: false, sms: true }] }),
    ).toThrow('valid mobile');
    expect(() =>
      validateReminderRecipientChannels({ ...options, recipientChannels: [{ id: 7, email: true, sms: false }] }),
    ).not.toThrow();
  });
  it('validates the updated phone before replacing a saved number', () => {
    expect(() =>
      validateReminderRecipientChannels({
        ...base,
        recipientChannels: [{ id: 7, email: false, sms: true }],
        recipientPhones: [{ id: 7, phone: '' }],
      }),
    ).toThrow('valid mobile');
  });
});
