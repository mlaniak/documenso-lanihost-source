import { colord } from 'colord';

type RecipientRouteMatch = {
  id: string;
  data: unknown;
};

/** Match the entire signing theme, including portals, to an explicit brand background. */
export const getRecipientTheme = (matches: readonly RecipientRouteMatch[]): 'light' | 'dark' | null => {
  for (const match of [...matches].reverse()) {
    // Signing and direct-template loaders use superLoaderJson; status pages
    // return plain objects. useMatches exposes the serialized { json, meta }
    // envelope, unlike useSuperLoaderData in the page itself.
    const data = match.data && typeof match.data === 'object' && 'json' in match.data ? match.data.json : match.data;

    if (!match.id.startsWith('routes/_recipient+') || !data || typeof data !== 'object' || !('branding' in data)) {
      continue;
    }

    const branding = data.branding;
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
