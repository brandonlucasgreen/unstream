import { useCallback, useState } from 'react';
import { contrastRatio } from '../utils/colors';
import { EmbedWidgetPreview } from './EmbedWidgetPreview';

type EmbedStyle = 'dark' | 'light' | 'custom';

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

/** "Embed this profile on your website": the controls, a live preview and the snippet. */
export function EmbedWidgetPanel({ artistName, slug }: { artistName: string; slug: string }) {
  const [style, setStyle] = useState<EmbedStyle>('dark');
  const [bg, setBg] = useState<string>(EMBED_THEMES.dark.bg);
  const [text, setText] = useState<string>(EMBED_THEMES.dark.text);
  const [maxLinks, setMaxLinks] = useState(6);
  const [copied, setCopied] = useState(false);

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
    'data-max-links': String(maxLinks),
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

      <div className="flex flex-wrap items-center gap-4 mb-3">
        <div className="flex items-center gap-2">
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
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">
            Links: <span>{maxLinks}</span>
          </span>
          <input
            type="range"
            min={3}
            max={12}
            value={maxLinks}
            onChange={(e) => setMaxLinks(Number(e.target.value))}
            className="w-20 accent-accent-primary"
          />
        </div>
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
          className="absolute top-2 right-2 px-3 py-1 rounded text-xs font-medium border-none cursor-pointer font-body bg-accent-primary/10 text-link hover:bg-accent-primary/20 transition-colors"
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
