import { colord } from 'colord';

type RecipientRouteMatch = {
  id: string;
  data: unknown;
};

/** Match the entire signing theme, including portals, to an explicit brand background. */
export const getRecipientTheme = (matches: readonly RecipientRouteMatch[]): 'light' | 'dark' | null => {
  for (const match of [...matches].reverse()) {
    if (
      !match.id.startsWith('routes/_recipient+') ||
      !match.data ||
      typeof match.data !== 'object' ||
      !('branding' in match.data)
    ) {
      continue;
    }

    const branding = match.data.branding;
    if (
      !branding ||
      typeof branding !== 'object' ||
      !('allowCustomBranding' in branding) ||
      branding.allowCustomBranding !== true ||
      !('colors' in branding) ||
      !branding.colors ||
      typeof branding.colors !== 'object' ||
      !('background' in branding.colors) ||
      typeof branding.colors.background !== 'string'
    ) {
      continue;
    }

    const background = colord(branding.colors.background);
    if (background.isValid()) {
      return background.isDark() ? 'dark' : 'light';
    }
  }

  return null;
};
