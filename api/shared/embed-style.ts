// The `style` an artist pastes with an embed is kept only for sizing and borders.
//
// It used to be copied through whole, so `position:fixed; inset:0; z-index:99999` turned a
// featured embed into a full-screen page of the embedding site's choosing, under the
// unstream.stream address. Shared by the save path (artist-profile.ts) and the crawler
// render (artist-page-static.ts); Node and Deno both import it.

const ALLOWED_EMBED_STYLE_PROPERTIES = new Set([
  'border',
  'border-radius',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
]);

/** Keep only allowed declarations; returns null when nothing survives. */
export function safeEmbedStyle(style: string): string | null {
  const kept = style
    .split(';')
    .map(declaration => {
      const colon = declaration.indexOf(':');
      if (colon === -1) return null;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (!ALLOWED_EMBED_STYLE_PROPERTIES.has(property) || !value) return null;
      // A value can't smuggle another declaration or a function like url() or expression().
      if (/[;:"'<>\\(){}]/.test(value)) return null;
      return `${property}: ${value}`;
    })
    .filter((declaration): declaration is string => declaration !== null);

  return kept.length > 0 ? kept.join('; ') : null;
}
