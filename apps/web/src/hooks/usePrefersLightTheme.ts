import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: light)';

function prefersLight(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(QUERY).matches
  );
}

/**
 * True when the OS is in light mode. The app has no in-app theme toggle —
 * index.css follows the OS via the same media query — so components that need
 * theme-aware inline colors (badge text fitted for contrast) read the same
 * signal here. Where matchMedia is unavailable (jsdom unit tests) this reads
 * as dark, the site's default theme.
 */
export function usePrefersLightTheme(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const media = window.matchMedia(QUERY);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    prefersLight,
    () => false
  );
}
