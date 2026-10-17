// The Tip button in the popup (docs/specs/artist-tips-spec.md §6, §9 phase 4).
//
// Mirrors the Mac app's ArtistTipButton — same label, same tooltip, same job: open the web tip page
// in the browser, where Stripe Checkout runs on the artist's own account. The extension never
// handles a payment, and there is no in-extension payment surface to review.
//
// Whether an artist takes tips arrives on the search result as `tipsEnabled`, which the server sets
// only for artists with tips live (attachTipsEnabled, gated behind the fan-facing tipsFans flag).
// There is deliberately no client-side flag check here: a result without `tipsEnabled` means "not
// taking tips", so the button renders for nobody else — no placeholder, no disabled state.
//
// The slug is the popup's own page-slug resolution, `claimedSlug || knownSlug` — the pair the
// server matches `tipsEnabled` against, and the same one the popup already uses for the artist page
// and the releases section. `id` is deliberately not a fallback: it is 'known-<slug>' for stored
// cards and a platform-derived id otherwise, and neither is a route.

export const TIP_PAGE_ORIGIN = 'https://unstream.stream';

// The artist-level click-out, alongside the extension's existing `click:{platformId}` metrics.
export const TIP_CLICK_METRIC = 'click:tip';

// Copy straight from the Mac contract. No fee numbers: the tip page shows the artist-chosen fee
// before anything is paid.
export function tipLabel(artistName) {
  return `Tip ${artistName}`;
}

export function tipTooltip(artistName) {
  return `Tip ${artistName} in your browser. The payment goes straight to their Stripe account.`;
}

/** An artist result's page slug, claimed first then known. Null for anything that isn't one. */
export function resultPageSlug(result) {
  if (!result || result.type !== 'artist') return null;
  return result.claimedSlug || result.knownSlug || null;
}

/**
 * The artist to tip in a result set, or null when nobody here takes tips.
 *
 * @param {Array<object>|null|undefined} results
 * @param {string} [fallbackArtistName] the detected artist, if the result carries no name
 * @returns {{ slug: string, artistName: string } | null}
 */
export function tipTarget(results, fallbackArtistName) {
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    if (!result || result.type !== 'artist' || result.tipsEnabled !== true) continue;
    const slug = resultPageSlug(result);
    if (slug) return { slug, artistName: result.name || fallbackArtistName || '' };
  }
  return null;
}

/** The web tip page. Checkout needs a real browser, so this always opens in a new tab. */
export function tipPageUrl(slug) {
  return `${TIP_PAGE_ORIGIN}/tip/${encodeURIComponent(slug)}`;
}

/**
 * Open the tip page and record the click-out.
 *
 * Two events, matching what a platform link click already sends: the artist-level metric carries
 * the slug, and the app event is the click-out the product dashboard counts.
 *
 * @param {{ slug: string } | null} target
 * @param {{ open?: Function, sendMessage?: Function }} [deps] seams for tests
 */
export function openTipPage(target, deps = {}) {
  if (!target || !target.slug) return;

  const open = deps.open
    || (typeof window !== 'undefined' ? window.open.bind(window) : null);
  const sendMessage = deps.sendMessage
    || (typeof chrome !== 'undefined' ? chrome.runtime.sendMessage.bind(chrome.runtime) : null);

  if (open) open(tipPageUrl(target.slug), '_blank', 'noopener');
  if (!sendMessage) return;

  sendMessage({ type: 'TRACK_ANALYTICS', slug: target.slug, metric: TIP_CLICK_METRIC });
  sendMessage({ type: 'TRACK_APP_EVENT', event_type: 'platform_click', context: { platform: 'tip' } });
}

/**
 * Render the Tip button into `container` — or empty and hide the container when this artist takes
 * no tips. Returns the button (null when there is nothing to tip), which is mostly for tests.
 *
 * @param {HTMLElement} container
 * @param {{ slug: string, artistName: string } | null} target
 * @param {{ open?: Function, sendMessage?: Function }} [deps]
 */
export function renderTipButton(container, target, deps = {}) {
  if (!target) {
    container.replaceChildren();
    container.classList.add('hidden');
    return null;
  }

  const tooltip = tipTooltip(target.artistName);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tip-button';
  button.title = tooltip;
  button.setAttribute('aria-label', tooltip);

  const heart = document.createElement('span');
  heart.className = 'tip-button-heart';
  heart.setAttribute('aria-hidden', 'true');
  heart.textContent = '♥';

  const label = document.createElement('span');
  label.className = 'tip-button-label';
  label.textContent = tipLabel(target.artistName);

  button.appendChild(heart);
  button.appendChild(label);
  button.addEventListener('click', () => openTipPage(target, deps));

  container.replaceChildren(button);
  container.classList.remove('hidden');
  return button;
}
