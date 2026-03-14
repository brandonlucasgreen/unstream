import { useState, useEffect, useCallback } from 'react';

type Theme = 'dark' | 'light';
type ThemePreference = 'dark' | 'light' | 'system';
const STORAGE_KEY = 'unstream-theme';

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getInitialPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'system';
}

function resolveTheme(pref: ThemePreference): Theme {
  return pref === 'system' ? getSystemTheme() : pref;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(getInitialPreference);
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(getInitialPreference()));

  const applyTheme = useCallback((pref: ThemePreference) => {
    const resolved = resolveTheme(pref);
    setPreferenceState(pref);
    setThemeState(resolved);
    document.documentElement.setAttribute('data-theme', resolved);
    if (pref === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  }, []);

  // Cycle: system -> light -> dark -> system
  function cycleTheme() {
    const next: ThemePreference =
      preference === 'system' ? 'light' :
      preference === 'light' ? 'dark' : 'system';
    applyTheme(next);
  }

  // Sync on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  // Listen for system preference changes when using system setting
  useEffect(() => {
    if (preference !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      const resolved = e.matches ? 'light' : 'dark';
      setThemeState(resolved);
      document.documentElement.setAttribute('data-theme', resolved);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [preference]);

  return { theme, preference, setTheme: applyTheme, cycleTheme };
}
