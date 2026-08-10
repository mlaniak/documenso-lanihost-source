import { RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { orderCertificateRecipients } from './certificate-recipients';

describe('orderCertificateRecipients', () => {
  it('lists CC recipients after every action recipient', () => {
    const recipients = [
      { id: 2, role: RecipientRole.CC, signingOrder: null, email: 'records@example.com' },
      { id: 3, role: RecipientRole.SIGNER, signingOrder: null, email: 'second@example.com' },
      { id: 1, role: RecipientRole.SIGNER, signingOrder: null, email: 'first@example.com' },
    ];

    expect(orderCertificateRecipients(recipients).map((recipient) => recipient.email)).toEqual([
      'first@example.com',
      'second@example.com',
      'records@example.com',
    ]);
  });

  it('preserves signing order before moving CC recipients to the end', () => {
    const recipients = [
      { id: 1, role: RecipientRole.SIGNER, signingOrder: 2 },
      { id: 2, role: RecipientRole.CC, signingOrder: null },
      { id: 3, role: RecipientRole.APPROVER, signingOrder: 1 },
      { id: 4, role: RecipientRole.SIGNER, signingOrder: 2 },
    ];

    expect(orderCertificateRecipients(recipients).map((recipient) => recipient.id)).toEqual([3, 1, 4, 2]);
  });

  it('does not mutate the envelope recipient list', () => {
    const recipients = [
      { id: 2, role: RecipientRole.CC, signingOrder: null },
      { id: 1, role: RecipientRole.SIGNER, signingOrder: null },
    ];

    orderCertificateRecipients(recipients);

    expect(recipients.map((recipient) => recipient.id)).toEqual([2, 1]);
  });
});
