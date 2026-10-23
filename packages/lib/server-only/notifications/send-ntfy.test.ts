import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../constants/crypto', () => ({ DOCUMENSO_ENCRYPTION_SECONDARY_KEY: 'test-encryption-key' }));
const { sendNtfy } = await import('./send-ntfy');
const { encryptSmsAuthToken } = await import('../sms/sms-credentials');
afterEach(() => vi.unstubAllGlobals());

describe('ntfy publisher', () => {
  const options = {
    serverUrl: 'https://ntfy.lanihost.com',
    token: encryptSmsAuthToken('private-publisher'),
    topic: 'private-staff',
    title: 'Document completed',
    message: 'A document is fully signed.',
    click: 'https://documents.example.com/inbox',
  };
  it('blocks a publicly readable topic before publishing any content', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(sendNtfy(options)).rejects.toThrow(/privacy/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('headers');
  });
  it('uses a bearer header, bounded requests and no redirects after verifying anonymous denial', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await sendNtfy(options);
    expect(fetch.mock.calls[1][0]).toBe('https://ntfy.lanihost.com');
    expect(fetch.mock.calls[1][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer private-publisher' },
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ topic: 'private-staff' });
  });
});
