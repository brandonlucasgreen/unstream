// The short artist bio under the detected artist's name.
//
// The server picks the bio (api/shared/artist-bio.ts) — one source, never stitched together —
// so this only decides which result's bio to show, whether Phase 2 may fill an empty one, and
// how to draw it. Pure DOM, no `chrome.*`, so it can be tested and rendered outside the popup.

/** Names the platform, except for a claimed artist's own words (decided 2026-09-30). */
const SOURCE_LABELS = {
  unstream: 'From the artist',
  bandcamp: 'From Bandcamp',
  discogs: 'From Discogs',
  // Wikipedia's text is CC BY-SA, which asks for the licence alongside the attribution.
  wikipedia: 'From Wikipedia · CC BY-SA',
};

export function bioSourceLabel(source) {
  return SOURCE_LABELS[source] || 'Source';
}

function normalizeName(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The result whose bio belongs under `artistName`: one with exactly that name (a claimed card
 * first), else the first artist result. Never a partial match — "Ruby" must not wear the
 * biography of "Synthetic Ruby".
 */
export function bioTarget(results, artistName) {
  const artists = (results || []).filter(r => r.type === 'artist');
  const wanted = normalizeName(artistName);
  const exact = artists.filter(r => normalizeName(r.name) === wanted);
  return exact.find(r => r.matchConfidence === 'claimed') || exact[0] || artists[0] || null;
}

/**
 * Whether Phase 2's bio may fill `result`'s empty slot.
 *
 * Only a gap: Phase 1's sources outrank Phase 2's, so an existing bio is never replaced. A
 * claimed card is never filled — the artist may have turned bios off — and Phase 2 describes
 * whoever MusicBrainz matched, so the names must agree exactly.
 */
export function shouldFillBio(result, enrichment) {
  if (!result || result.bio || result.bioSuppressed || result.matchConfidence === 'claimed') return false;
  if (!enrichment?.bio || !enrichment.artistName) return false;
  return normalizeName(enrichment.artistName) === normalizeName(result.name);
}

function isWebUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Draw `bio` into `container`: the text clamped by CSS, a "More" toggle when the clamp is
 * hiding something, and always a link to the source. Text goes in through textContent only —
 * a bio is plain text and must never become markup.
 *
 * Call after `container` is visible: whether the clamp hides anything is measured, and a
 * hidden element measures as zero.
 */
export function renderArtistBio(container, bio) {
  if (!bio || !bio.text) {
    container.replaceChildren();
    container.classList.add('hidden');
    return;
  }

  const text = document.createElement('div');
  text.className = 'artist-bio-text';
  for (const paragraph of bio.text.split('\n\n')) {
    const p = document.createElement('p');
    p.textContent = paragraph;
    text.appendChild(p);
  }

  const footer = document.createElement('div');
  footer.className = 'artist-bio-footer';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'artist-bio-toggle hidden';
  toggle.textContent = 'More';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const expanded = container.classList.toggle('expanded');
    toggle.textContent = expanded ? 'Less' : 'More';
    toggle.setAttribute('aria-expanded', String(expanded));
  });
  footer.appendChild(toggle);

  if (isWebUrl(bio.sourceUrl)) {
    const source = document.createElement('a');
    source.className = 'artist-bio-source';
    source.href = bio.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = `${bioSourceLabel(bio.source)}${bio.truncated ? ' · Read more' : ''} ↗`;
    footer.appendChild(source);
  }

  container.classList.remove('expanded', 'hidden');
  container.replaceChildren(text, footer);

  if (text.scrollHeight > text.clientHeight + 1) toggle.classList.remove('hidden');
}
