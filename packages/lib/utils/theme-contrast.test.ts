import { readFileSync } from 'node:fs';
import { colord, extend } from 'colord';
import a11yPlugin from 'colord/plugins/a11y';
import colors from 'tailwindcss/colors';
import { describe, expect, it } from 'vitest';

extend([a11yPlugin]);

const css = readFileSync(new URL('../../ui/styles/theme.css', import.meta.url), 'utf8');
const [lightTheme, darkTheme] = css.split('.dark:not(.dark-mode-disabled)');

const token = (theme: string, name: string) => {
  const value = theme.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1];
  if (!value) {
    throw new Error(`Missing theme token: ${name}`);
  }
  return colord(`hsl(${value})`);
};

describe('shared helper text contrast', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('meets WCAG AA for small text on %s app surfaces', (_name, theme) => {
    const text = token(theme, 'muted-foreground');
    for (const surface of ['background', 'muted', 'card', 'popover', 'secondary', 'accent']) {
      expect(text.contrast(token(theme, surface)), `${surface} helper text`).toBeGreaterThanOrEqual(4.5);
    }
    expect(token(theme, 'destructive-foreground').contrast(token(theme, 'destructive'))).toBeGreaterThanOrEqual(4.5);
  });
});

// Derive the colors from the component's actual utility classes rather than
// pinning an expected shade: any future palette choice still has to meet AA.
const shareDialog = readFileSync(
  new URL('../../ui/components/document/document-share-button.tsx', import.meta.url),
  'utf8',
);
const shareTextColors = [...shareDialog.matchAll(/(?<dark>dark:)?text-blue-(?<shade>\d+)/g)];

it('keeps share-card text and URLs readable on both dialog themes', () => {
  expect(shareTextColors.length).toBeGreaterThan(0);
  for (const match of shareTextColors) {
    const shade = match.groups?.shade as keyof typeof colors.blue;
    const background = token(match.groups?.dark ? darkTheme : lightTheme, 'background');
    expect(colord(colors.blue[shade]).contrast(background), match[0]).toBeGreaterThanOrEqual(4.5);
  }
});
