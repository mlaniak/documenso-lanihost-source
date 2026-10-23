import { decryptSmsAuthToken } from '../sms/sms-credentials';
import { getNtfyOrigin } from './settings';

export const sendNtfy = async (options: {
  serverUrl: string;
  token: string;
  topic: string;
  title: string;
  message: string;
  click: string;
}) => {
  const origin = getNtfyOrigin(options.serverUrl);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.topic)) {
    throw new Error('Invalid ntfy topic');
  }
  // Fail closed for accidentally public topics. Never put credentials in a URL.
  const anonymous = await fetch(`${origin}/${options.topic}/json?poll=1`, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  await anonymous.body?.cancel();
  if (![401, 403].includes(anonymous.status)) {
    throw new Error('ntfy topic privacy could not be verified; publishing was blocked');
  }
  const response = await fetch(origin, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${decryptSmsAuthToken(options.token)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: options.topic,
      title: options.title,
      message: options.message,
      click: options.click,
    }),
  });
  await response.body?.cancel();
  if (!response.ok) {
    // Deliberately exclude body/URL/token from errors and job logs.
    throw new Error(`ntfy rejected the notification (${response.status})`);
  }
};
