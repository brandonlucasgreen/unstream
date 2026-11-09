import { useCallback, useState } from 'react';
import { contrastRatio } from '../utils/colors';
import { sources, sourceCategories } from '../services/sources';
import type { SourceId } from '../types';
import { EmbedWidgetPreview } from './EmbedWidgetPreview';
import { EmbedPlatformList } from './EmbedPlatformList';

type EmbedStyle = 'dark' | 'light' | 'custom';
type EmbedLayout = 'icons' | 'flexible' | 'full';

const LAYOUT_LABELS: Record<EmbedLayout, string> = {
  icons: 'Icons only',
  flexible: 'Flexible',
  full: 'Full width',
};

/**
 * The platforms the widget can draw, once each, in the order the artist's page lists them. Its
 * table holds every platform in sources.ts except the category buckets and custom links ('other'),
 * which platform-logo-copies.test.ts keeps true.
 */
export function embeddablePlatforms(links: { platform: string }[]): SourceId[] {
  const ids: SourceId[] = [];
  for (const { platform } of links) {
    const known = platform in sources && !(platform in sourceCategories) && platform !== 'other';
    if (known && !ids.includes(platform as SourceId)) ids.push(platform as SourceId);
  }
  return ids;
}

// widget.js's own THEMES. Custom colours start from the preset the artist was looking at.
export const EMBED_THEMES = {
  dark: { bg: '#1a1a1a', text: '#f0f0f0' },
  light: { bg: '#ffffff', text: '#1a1a1a' },
} as const;

// Below WCAG AA for body text, the widget's small labels get hard to read.
const MIN_CONTRAST = 4.5;

// For a value pasted into the embed snippet's HTML attributes.
function escapeAttribute(value: string): string {
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

function isReordered(pageOrder: SourceId[], embedOrder: SourceId[]): boolean {
  return embedOrder.some((id, index) => id !== pageOrder[index]);
}

/**
 * The snippet's data-platforms. Everything in page order is "all"; everything reordered keeps a
 * trailing "*", so a platform added to the page later still appears (at the end). A subset is
 * exactly that subset, in embed order.
 */
export function platformsAttribute(
  pageOrder: SourceId[],
  embedOrder: SourceId[],
  excluded: Set<SourceId>,
): string {
  const chosen = embedOrder.filter((id) => !excluded.has(id));
  if (chosen.length < pageOrder.length) return chosen.join(',');
  return isReordered(pageOrder, embedOrder) ? [...chosen, '*'].join(',') : 'all';
}

/** "Embed this profile on your website": the controls, a live preview and the snippet. */
export function EmbedWidgetPanel({ artistName, slug, links }: {
  artistName: string;
  slug: string;
  /** The artist's links in page order, socials included. */
  links: { platform: string }[];
}) {
  const [style, setStyle] = useState<EmbedStyle>('dark');
  const [bg, setBg] = useState<string>(EMBED_THEMES.dark.bg);
  const [text, setText] = useState<string>(EMBED_THEMES.dark.text);
  const [layout, setLayout] = useState<EmbedLayout>('flexible');
  // What the artist unticked, rather than what they ticked: with nothing unticked the embed
  // carries "all", and picks up links they add later without a new snippet.
  const [excluded, setExcluded] = useState<Set<SourceId>>(new Set());
  // The embed's own order, starting from the page's. Changing it never touches the page.
  const [order, setOrder] = useState<SourceId[]>(() => embeddablePlatforms(links));
  const [copied, setCopied] = useState(false);

  const platforms = embeddablePlatforms(links);
  // Robust to the page's links changing under the panel: drop the gone, append the new.
  const ordered = [
    ...order.filter((id) => platforms.includes(id)),
    ...platforms.filter((id) => !order.includes(id)),
  ];
  const chosen = ordered.filter((id) => !excluded.has(id));
  const allChosen = chosen.length === platforms.length;
  const reordered = isReordered(platforms, ordered);
  const toggle = (id: SourceId) => {
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

  const embedCode = `<div class="unstream-widget" ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(' ')}></div>
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
      <h2 className="text-xs uppercase tracking-wider text-text-muted mb-3">
        Embed this profile on your website
      </h2>

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
        <EmbedWidgetPreview attributes={attributes} />
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
