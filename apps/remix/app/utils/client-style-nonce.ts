import { setNonce } from 'get-nonce';

/** Configure Radix's scroll-lock styles before any components mount. */
export const initializeClientStyleNonce = (pageDocument: Document): void => {
  // Browsers hide the nonce attribute from getAttribute(); the DOM property
  // retains the nonce of the current HTML response, including after SPA navigation.
  const nonce = pageDocument.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;

  setNonce(nonce ?? '');
};
