// i18next bootstrap for the web SPA.
//
// Hand-rolled on purpose: the plan for P1 keeps the dependency surface to
// i18next + react-i18next and skips i18next-browser-languagedetector. The only
// detection we need is "cookie wins, else the browser's own preference, else
// English", which is the same five lines either way — and this way the
// supported-language list lives in one place instead of being duplicated in a
// detector config.
//
// SSR (api/edge) stays English: this module is only imported by the SPA entry.

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import enCommon from '../../../api/shared/locales/en/common.json';
import enArtist from '../../../api/shared/locales/en/artist.json';
import enTips from '../../../api/shared/locales/en/tips.json';

export const LANGUAGE_COOKIE = 'unstream_lang';

/** Languages the bundles below cover. English first — it is the fallback. */
export const supportedLanguages = ['en'] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

/** Display labels for the switcher, in `supportedLanguages` order. */
export const languageLabels: Record<SupportedLanguage, string> = {
  en: 'English',
};

const resources = {
  en: {
    common: enCommon,
    artist: enArtist,
    tips: enTips,
  },
};

function isSupported(value: string | undefined | null): value is SupportedLanguage {
  return value != null && (supportedLanguages as readonly string[]).includes(value);
}

/** Read the language cookie. `unstream_lang=en` — first segment only. */
export function readLanguageCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)unstream_lang=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * The language to start in: an explicit cookie, else the first supported
 * language the browser asks for, else English.
 */
function detectLanguage(): SupportedLanguage {
  const fromCookie = readLanguageCookie();
  if (isSupported(fromCookie)) return fromCookie;

  const preferences =
    typeof navigator !== 'undefined'
      ? navigator.languages ?? [navigator.language]
      : [];

  for (const preference of preferences) {
    const base = preference.split('-')[0];
    if (isSupported(base)) return base;
  }

  return 'en';
}

/** Persist the choice for the next visit; `max-age` one year, path-wide. */
export function writeLanguageCookie(lng: SupportedLanguage): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LANGUAGE_COOKIE}=${lng}; max-age=31536000; path=/; samesite=lax`;
}

i18next.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: 'en',
  ns: ['common', 'artist', 'tips'],
  defaultNS: 'common',
  // Default is already true, but pin it: every value in the dictionaries is
  // plain text, and this is what guarantees a translator can't open an
  // injection hole by shipping markup in a JSON value.
  interpolation: { escapeValue: true },
  returnNull: false,
});

// Keep <html lang> in sync so screen readers, hyphenation and search engines
// see the language actually being rendered.
if (typeof document !== 'undefined') {
  document.documentElement.lang = i18next.language;
  i18next.on('languageChanged', (lng) => {
    document.documentElement.lang = lng;
  });
}

export default i18next;
