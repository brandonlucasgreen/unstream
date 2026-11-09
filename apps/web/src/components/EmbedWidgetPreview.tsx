import { useEffect } from 'react';

declare global {
  interface Window {
    UnstreamWidget?: { init: () => void };
  }
}

// The preview is the embed itself: /widget.js, the file artists paste onto their sites, drawing
// into this page. It used to be a React mock-up of the widget, which drifted from it — names
// without icons, payout figures the widget doesn't show, and a Subvert link the widget dropped.
let widgetScript: Promise<void> | null = null;

function loadWidgetScript(): Promise<void> {
  if (window.UnstreamWidget) return Promise.resolve();
  if (!widgetScript) {
    widgetScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/widget.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        widgetScript = null;
        script.remove();
        reject(new Error('widget.js failed to load'));
      };
      document.body.appendChild(script);
    });
  }
  return widgetScript;
}

interface EmbedWidgetPreviewProps {
  artistName: string;
  slug: string;
  theme: 'dark' | 'light';
  maxLinks: number;
}

export function EmbedWidgetPreview({ artistName, slug, theme, maxLinks }: EmbedWidgetPreviewProps) {
  // The widget draws each container once, so a change of theme or link count swaps in a fresh
  // container (the key below) and asks the widget to draw it. widget.js fetches the artist once
  // per page, so dragging the slider doesn't refetch.
  useEffect(() => {
    let cancelled = false;
    loadWidgetScript()
      .then(() => {
        if (!cancelled) window.UnstreamWidget?.init();
      })
      .catch((err) => console.warn('[EmbedWidgetPreview]', err));
    return () => {
      cancelled = true;
    };
  }, [artistName, slug, theme, maxLinks]);

  return (
    <div
      key={`${slug}-${theme}-${maxLinks}`}
      className="unstream-widget"
      data-artist={artistName}
      data-slug={slug}
      data-theme={theme}
      data-max-links={maxLinks}
    />
  );
}
