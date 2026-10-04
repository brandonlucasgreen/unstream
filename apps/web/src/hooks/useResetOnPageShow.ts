import { useEffect, useRef } from 'react';

/**
 * Calls `reset` when the browser restores this page from the back/forward cache.
 *
 * A page that sends someone to Stripe sets a "busy" flag first. If they press Back, the browser
 * can restore the page exactly as it was left — flag still set, buttons still disabled, "Opening
 * Stripe…" still showing — without re-running any React code. `pageshow` with `persisted` is the
 * one signal that this happened.
 */
export function useResetOnPageShow(reset: () => void): void {
  const resetRef = useRef(reset);
  useEffect(() => {
    resetRef.current = reset;
  });

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resetRef.current();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
}
