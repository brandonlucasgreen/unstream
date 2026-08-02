// The artist's catalogue, expanded in the popup.
//
// Symmetric with what the Mac app does: finding an artist should lead to their releases and what
// those releases cost, not stop at a row of platform links. Until this existed, the only way to
// reach a buying guide in the extension was to wait for a release *alert* — which requires the
// artist to be saved, a scheduled check to have run, and the release to be new. A record put out
// last year was unreachable.
//
// Pure DOM from a GET /api/artist-page?slug={slug} response — no `chrome.*` and no fetching, so it
// can be rendered outside the extension to look at. Fetching and opening URLs arrive as callbacks,
// because only the popup knows those mean `fetch` behind host permissions and `chrome.tabs.create`
// behind an allowlist check.

import { renderReleaseGuide, guideMessage } from './release-guide.js';
import { formatReleaseDate } from './release-display.js';

/**
 * Fill `panel` with an artist's releases.
 *
 * @param {HTMLElement} panel
 * @param {object} page              The endpoint's response.
 * @param {string} slug              The artist's slug, for building release URLs.
 * @param {(artist: string, release: string) => Promise<object>} fetchRelease
 * @param {(url: string) => void} onOpenUrl
 */
export function renderArtistReleases(panel, page, slug, fetchRelease, onOpenUrl) {
  const releases = page.releases || [];

  if (releases.length === 0) {
    // Coverage is demand-driven, so an empty catalogue usually means "not looked at yet" rather
    // than "this artist has released nothing". Don't say the second.
    panel.replaceChildren(guideMessage('No releases catalogued for this artist yet.'));
    return;
  }

  const children = releases.map(release =>
    buildReleaseRow(release, slug, fetchRelease, onOpenUrl)
  );

  // The endpoint caps the list at 60. Say when there are more rather than letting the list imply
  // it is the whole catalogue.
  const total = page.releaseCount ?? releases.length;
  if (total > releases.length) {
    const more = document.createElement('div');
    more.className = 'guide-footnote';
    more.textContent = `Showing ${releases.length} of ${total}.`;
    children.push(more);
  }

  panel.replaceChildren(...children);
}

function buildReleaseRow(release, artistSlug, fetchRelease, onOpenUrl) {
  const wrapper = document.createElement('div');
  wrapper.className = 'artist-release';

  const button = document.createElement('button');
  button.className = 'artist-release-row';
  button.setAttribute('aria-expanded', 'false');

  const info = document.createElement('span');
  info.className = 'artist-release-info';

  const title = document.createElement('span');
  title.className = 'artist-release-title';
  title.textContent = release.title;

  const meta = document.createElement('span');
  // The price is the reason to open the guide, so it leads when we have one. Otherwise the date,
  // which at least says what this is. `offerSummary` is computed server-side — pricing it here
  // would mean carrying a copy of the payout registry.
  const summary = release.offerSummary || '';
  if (summary) {
    meta.className = 'artist-release-price';
    meta.textContent = summary;
  } else {
    meta.className = 'artist-release-date';
    meta.textContent = formatReleaseDate(release.releaseDate, release.datePrecision);
  }

  info.appendChild(title);
  if (meta.textContent) info.appendChild(meta);

  const chevron = document.createElement('span');
  chevron.className = 'artist-release-chevron';
  chevron.textContent = '›';

  button.appendChild(info);
  button.appendChild(chevron);

  const guidePanel = document.createElement('div');
  guidePanel.className = 'release-guide hidden';

  const releaseUrl = `https://unstream.stream/a/${artistSlug}/${release.slug}`;
  let loaded = false;

  button.addEventListener('click', async () => {
    const isOpen = !guidePanel.classList.contains('hidden');
    if (isOpen) {
      guidePanel.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      wrapper.classList.remove('is-open');
      return;
    }

    guidePanel.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('is-open');
    if (loaded) return;

    guidePanel.replaceChildren(guideMessage('Checking where to buy…'));
    try {
      const detail = await fetchRelease(artistSlug, release.slug);
      renderReleaseGuide(guidePanel, detail, releaseUrl, onOpenUrl);
      loaded = true;
    } catch (error) {
      console.error('[Unstream] Release guide fetch failed:', error);
      // Deliberately not "this release has no sources" — we don't know that.
      guidePanel.replaceChildren(guideMessage("Couldn't load prices just now."));
    }
  });

  wrapper.appendChild(button);
  wrapper.appendChild(guidePanel);
  return wrapper;
}
