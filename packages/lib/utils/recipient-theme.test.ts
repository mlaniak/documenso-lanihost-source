import { describe, expect, it } from 'vitest';

import { getRecipientTheme } from './recipient-theme';

const recipientMatch = (background: string, allowCustomBranding = true) => ({
  id: 'routes/_recipient+/sign.$token+/complete',
  data: { branding: { allowCustomBranding, colors: { background } } },
});

describe('getRecipientTheme', () => {
  it('uses a light theme for the white branded completion page even when the account uses dark mode', () => {
    expect(getRecipientTheme([{ id: 'root', data: { theme: 'dark' } }, recipientMatch('#ffffff')])).toBe('light');
  });

  it('uses a dark theme for a dark branded signing page', () => {
    expect(getRecipientTheme([{ id: 'root', data: { theme: 'light' } }, recipientMatch('#101827')])).toBe('dark');
  });

  it('restores the account theme outside recipient routes', () => {
    expect(getRecipientTheme([{ ...recipientMatch('#ffffff'), id: 'routes/_authenticated+/documents' }])).toBeNull();
  });

  it('keeps the account theme when branding is disabled or does not define a background', () => {
    expect(getRecipientTheme([recipientMatch('#ffffff', false)])).toBeNull();
    expect(
      getRecipientTheme([
        {
          id: 'routes/_recipient+/sign.$token+/_index',
          data: { branding: { allowCustomBranding: true, colors: { primary: '#123456' } } },
        },
      ]),
    ).toBeNull();
  });

  it('ignores invalid or missing branding data', () => {
    for (const data of [null, {}, { branding: null }, { branding: { allowCustomBranding: true, colors: null } }]) {
      expect(getRecipientTheme([{ id: 'routes/_recipient+/sign.$token+/complete', data }])).toBeNull();
    }
    expect(getRecipientTheme([recipientMatch('not-a-color')])).toBeNull();
  });
});
