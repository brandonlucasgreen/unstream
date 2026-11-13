import { useCallback, useState } from 'react';
import { contrastRatio } from '../utils/colors';
import { sources, sourceCategories } from '../services/sources';
import type { SourceId } from '../types';
import { EmbedWidgetPreview } from './EmbedWidgetPreview';
import { EmbedPlatformList } from './EmbedPlatformList';

type EmbedStyle = 'dark' | 'light' | 'custom';
type EmbedLayout = 'icons' | 'text' | 'flexible' | 'full';

const LAYOUT_LABELS: Record<EmbedLayout, string> = {
  icons: 'Icons only',
  text: 'Text only',
  flexible: 'Flexible',
  full: 'Full width',
};

type EmbedLink = { platform: string; displayName?: string | null };

/**
 * A custom link the artist added to their page. The page stores them as other_0, other_1, ... in
 * page order (api/shared/link-dividers.ts); older rows may say just "other". widget.js draws them
 * with their own label, by the same test.
 */
export function isCustomLink(platform: string): boolean {
  return platform === 'other' || /^other_[0-9]+$/.test(platform);
}

/**
 * What the widget can draw, once each, in the order the artist's page lists them: every platform
 * in sources.ts except the category buckets (widget.js's table, which platform-logo-copies.test.ts
 * keeps true), plus each of the artist's custom links.
 */
export function embeddablePlatforms(links: EmbedLink[]): string[] {
  const ids: string[] = [];
  for (const { platform } of links) {
    const known = platform in sources && !(platform in sourceCategories) && platform !== 'other';
    if ((known || isCustomLink(platform)) && !ids.includes(platform)) ids.push(platform);
  }
  return ids;
}

/** The name the widget shows for each choice: a custom link's own label, else the platform's. */
function embedLabels(links: EmbedLink[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const { platform, displayName } of links) {
    if (isCustomLink(platform)) labels[platform] = displayName || 'Link';
    else if (platform in sources) labels[platform] = sources[platform as SourceId].name;
  }
  return labels;
}

// widget.js's own THEMES. Custom colours start from the preset the artist was looking at.
export const EMBED_THEMES = {
  dark: { bg: '#1a1a1a', text: '#f0f0f0' },
  light: { bg: '#ffffff', text: '#1a1a1a' },
} as const;

// Below WCAG AA for body text, the widget's small labels get hard to read.
const MIN_CONTRAST = 4.5;

// For a value pasted into the embed snippet's HTML (attributes and the fallback link's text).
function escapeForSnippet(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const optionClass = (selected: boolean) =>
  `px-2.5 py-1 rounded text-xs font-medium border-none cursor-pointer font-body transition-colors ${
    selected
      ? 'bg-accent-primary/15 text-link'
      : 'bg-bg-secondary text-text-muted hover:text-text-primary'
  }`;

function ColourField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      {label}:
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-6 p-0 border border-border rounded cursor-pointer bg-transparent"
        aria-label={`${label} colour`}
      />
      <span className="font-mono">{value}</span>
    </label>
  );
}

function isReordered(pageOrder: string[], embedOrder: string[]): boolean {
  return embedOrder.some((id, index) => id !== pageOrder[index]);
}

/**
 * The snippet's data-platforms. Everything in page order is "all"; everything reordered keeps a
 * trailing "*", so a platform added to the page later still appears (at the end). A subset is
 * exactly that subset, in embed order.
 */
export function platformsAttribute(
  pageOrder: string[],
  embedOrder: string[],
  excluded: Set<string>,
): string {
  const chosen = embedOrder.filter((id) => !excluded.has(id));
  if (chosen.length < pageOrder.length) return chosen.join(',');
  return isReordered(pageOrder, embedOrder) ? [...chosen, '*'].join(',') : 'all';
}

/** "Embed this profile on your website": the controls, a live preview and the snippet. */
export function EmbedWidgetPanel({ artistName, slug, links, showHeading = true }: {
  artistName: string;
  slug: string;
  /** The artist's links in page order, socials and custom links included. */
  links: EmbedLink[];
  /** Off where the page around it already says what this is (the Promote tab). */
  showHeading?: boolean;
}) {
  const [style, setStyle] = useState<EmbedStyle>('dark');
  const [bg, setBg] = useState<string>(EMBED_THEMES.dark.bg);
  const [text, setText] = useState<string>(EMBED_THEMES.dark.text);
  const [layout, setLayout] = useState<EmbedLayout>('flexible');
  // What the artist unticked, rather than what they ticked: with nothing unticked the embed
  // carries "all", and picks up links they add later without a new snippet.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // The embed's own order, starting from the page's. Changing it never touches the page.
  const [order, setOrder] = useState<string[]>(() => embeddablePlatforms(links));
  const [copied, setCopied] = useState(false);

  const platforms = embeddablePlatforms(links);
  const labels = embedLabels(links);
  // Robust to the page's links changing under the panel: drop the gone, append the new.
  const ordered = [
    ...order.filter((id) => platforms.includes(id)),
    ...platforms.filter((id) => !order.includes(id)),
  ];
  const chosen = ordered.filter((id) => !excluded.has(id));
  const allChosen = chosen.length === platforms.length;
  const reordered = isReordered(platforms, ordered);
  const toggle = (id: string) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  };

  const chooseStyle = (next: EmbedStyle) => {
    if (next === 'custom' && style !== 'custom') {
      setBg(EMBED_THEMES[style].bg);
      setText(EMBED_THEMES[style].text);
    }
    setStyle(next);
  };

  // One set of attributes for both the snippet and the preview. data-slug lets the widget find
  // this exact page; data-artist is its fallback and its label.
  const attributes: Record<string, string> = {
    'data-artist': artistName,
    'data-slug': slug,
    ...(style === 'custom'
      ? { 'data-bg': bg, 'data-text': text }
      : { 'data-theme': style }),
    'data-layout': layout,
    'data-platforms': platformsAttribute(platforms, ordered, excluded),
  };

  // What the embed shows if widget.js never runs (a content blocker, scripts off, a network
  // failure): a plain link to the artist's page. The widget draws into a shadow root, which hides
  // the link once it has rendered, so visitors see one or the other, never both.
  const fallback = {
    href: `https://unstream.stream/a/${encodeURIComponent(slug)}`,
    text: `Support ${artistName} directly`,
  };

  const embedCode = `<div class="unstream-widget" ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeForSnippet(value)}"`)
    .join(' ')}><a href="${fallback.href}">${escapeForSnippet(fallback.text)}</a></div>
<script src="https://unstream.stream/widget.js" async></script>`;

  const lowContrast = style === 'custom' && contrastRatio(text, bg) < MIN_CONTRAST;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[EmbedWidgetPanel] clipboard.writeText failed:', err);
    }
  }, [embedCode]);

  return (
    <div className="pb-6 text-left">
      {showHeading && (
        <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">
          Embed this profile on your website
        </h2>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-text-muted">Theme:</span>
        <button onClick={() => chooseStyle('dark')} className={optionClass(style === 'dark')}>
          Dark
        </button>
        <button onClick={() => chooseStyle('light')} className={optionClass(style === 'light')}>
          Light
        </button>
        <button onClick={() => chooseStyle('custom')} className={optionClass(style === 'custom')}>
          Custom
        </button>
      </div>

      {style === 'custom' && (
        <div className="flex flex-wrap items-center gap-4 mb-3">
          <ColourField label="Background" value={bg} onChange={setBg} />
          <ColourField label="Text" value={text} onChange={setText} />
          {lowContrast && (
            <p className="text-xs text-text-muted w-full m-0" role="status">
              These colours are close together, so fans may find the links hard to read.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-text-muted">Links:</span>
        {(Object.keys(LAYOUT_LABELS) as EmbedLayout[]).map((option) => (
          <button key={option} onClick={() => setLayout(option)} className={optionClass(layout === option)}>
            {LAYOUT_LABELS[option]}
          </button>
        ))}
      </div>

      <fieldset className="mb-3 border-0 p-0 m-0">
        <legend className="text-xs text-text-muted mb-2 p-0">
          Platforms to include, in order (drag to rearrange; this doesn't change your page):
        </legend>
        <EmbedPlatformList
          order={ordered}
          excluded={excluded}
          labelFor={(id) => labels[id]}
          onReorder={setOrder}
          onToggle={toggle}
        />
        <p className="text-xs text-text-muted mt-2 mb-0">
          {chosen.length === 0
            ? 'Pick at least one platform to embed.'
            : !allChosen
              ? "Only these. A platform you add to your page later won't appear until you copy a new snippet."
              : reordered
                ? 'In this order. A platform you add to your page later goes at the end.'
                : 'Every platform on your page, in its order, including any you add later.'}
          {reordered && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setOrder(platforms)}
                className="text-link bg-transparent border-none p-0 cursor-pointer underline font-body text-xs"
              >
                Use my page's order
              </button>
            </>
          )}
        </p>
      </fieldset>

      {/* The real widget, drawn by /widget.js exactly as it will be on the artist's site. */}
      <div className="bg-bg-primary rounded-lg p-4 mb-3 border border-border">
        <div className="text-xs text-text-muted uppercase tracking-wider mb-3">
          Embed preview
        </div>
        <EmbedWidgetPreview attributes={attributes} fallback={fallback} />
      </div>

      <div className="relative">
        <pre className="bg-bg-secondary border border-border rounded-lg p-4 pr-16 overflow-x-auto text-xs text-text-muted font-mono whitespace-pre-wrap break-all">
          {embedCode}
        </pre>
        <button
          onClick={handleCopy}
          disabled={chosen.length === 0}
          className="absolute top-2 right-2 px-3 py-1 rounded text-xs font-medium border-none cursor-pointer font-body bg-accent-primary/10 text-link hover:bg-accent-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-text-muted mt-2">
        Paste this into your website's HTML. The widget loads asynchronously and won't affect your page speed.
      </p>
    </div>
  );
}
