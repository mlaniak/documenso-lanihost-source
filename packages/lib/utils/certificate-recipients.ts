import { RecipientRole } from '@prisma/client';

type CertificateRecipient = {
  id: number;
  role: RecipientRole;
  signingOrder: number | null;
};

/**
 * Keep the certificate's participant list deterministic and easy to read.
 *
 * Recipients who take an action follow the configured signing order (then
 * creation order for ties and parallel documents). CC recipients are listed
 * last because they only receive the completed document.
 */
export const orderCertificateRecipients = <T extends CertificateRecipient>(recipients: T[]): T[] => {
  return [...recipients].sort((left, right) => {
    const leftIsCc = left.role === RecipientRole.CC;
    const rightIsCc = right.role === RecipientRole.CC;

    if (leftIsCc !== rightIsCc) {
      return leftIsCc ? 1 : -1;
    }

    if (!leftIsCc && left.signingOrder !== right.signingOrder) {
      if (left.signingOrder === null) {
        return 1;
      }

      if (right.signingOrder === null) {
        return -1;
      }

      return left.signingOrder - right.signingOrder;
    }

    return left.id - right.id;
  });
};
