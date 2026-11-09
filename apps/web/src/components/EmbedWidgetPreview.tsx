import { useEffect, useRef, useState } from 'react';

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
      // A content blocker refusing the request lands here too.
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

/**
 * Draws the widget from the same `data-*` attributes and fallback link the embed snippet carries,
 * so the preview can't show anything the snippet wouldn't. When this browser doesn't run the
 * widget, the fallback link stays visible — exactly what a visitor in the same position sees on
 * the artist's site — with a note saying why.
 */
export function EmbedWidgetPreview({ attributes, fallback }: {
  attributes: Record<string, string>;
  fallback: { href: string; text: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  // The widget draws each container once, so any change swaps in a fresh container (the key
  // below) and asks the widget to draw it. widget.js fetches the artist once per page, so
  // dragging the slider or a colour picker doesn't refetch.
  const key = JSON.stringify(attributes);

  useEffect(() => {
    let cancelled = false;
    loadWidgetScript()
      .then(() => {
        if (cancelled) return;
        window.UnstreamWidget?.init();
        // The widget attaches its shadow root synchronously in init(); without one, something
        // stopped it.
        setBlocked(!container.current?.shadowRoot);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[EmbedWidgetPreview]', err);
        setBlocked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return (
    <>
      <div key={key} ref={container} className="unstream-widget" {...attributes}>
        <a href={fallback.href} className="text-link text-sm">{fallback.text}</a>
      </div>
      {blocked && (
        <p className="text-xs text-text-muted mt-3 mb-0" role="note">
          This browser didn&rsquo;t run the embed, often because of a content blocker. Visitors in
          the same position see the link above instead, which goes to your Unstream page. Your
          snippet is fine to copy.
        </p>
      )}
    </>
  );
}
