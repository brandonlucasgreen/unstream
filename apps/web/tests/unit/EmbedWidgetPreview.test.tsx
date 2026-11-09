// @vitest-environment jsdom
// The embed preview runs the real /widget.js. When this browser doesn't (a content blocker
// refusing the script, say), the snippet's fallback link stays visible and a note says why.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { EmbedWidgetPreview } from '../../src/components/EmbedWidgetPreview';

const attributes = { 'data-artist': 'Kid Lightbulbs', 'data-slug': 'kid-lightbulbs', 'data-theme': 'dark' };
const fallback = { href: 'https://unstream.stream/a/kid-lightbulbs', text: 'Support Kid Lightbulbs directly' };

describe('EmbedWidgetPreview', () => {
  afterEach(() => {
    cleanup();
    delete window.UnstreamWidget;
    document.querySelectorAll('script[src="/widget.js"]').forEach((s) => s.remove());
  });

  it('keeps the fallback link and says so when the widget script is blocked', async () => {
    render(<EmbedWidgetPreview attributes={attributes} fallback={fallback} />);
    const script = document.querySelector('script[src="/widget.js"]')!;
    expect(script).toBeTruthy();

    // What a content blocker refusing the request looks like to the page.
    act(() => {
      script.dispatchEvent(new Event('error'));
    });

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/content blocker/);
    expect(screen.getByRole('link', { name: fallback.text }).getAttribute('href')).toBe(fallback.href);
  });

  it('shows no note once the widget has drawn itself', async () => {
    window.UnstreamWidget = {
      init: () => {
        document.querySelectorAll<HTMLElement>('.unstream-widget').forEach((el) => {
          if (!el.shadowRoot) el.attachShadow({ mode: 'open' });
        });
      },
    };
    render(<EmbedWidgetPreview attributes={attributes} fallback={fallback} />);
    await waitFor(() => expect(document.querySelector('.unstream-widget')!.shadowRoot).toBeTruthy());
    expect(screen.queryByRole('note')).toBeNull();
  });
});
