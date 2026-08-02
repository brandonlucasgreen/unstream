// Builds the buying-guide panel that expands under a release alert in the popup.
//
// Pure DOM construction from a GET /api/release/{artist}/{release} response — no `chrome.*` and
// no fetching, so the same code can be rendered outside the extension to look at. Opening a URL
// arrives as a callback, because only the popup knows that it means `chrome.tabs.create` behind
// an allowlist check.

import {
  AVAILABILITY_LABELS,
  formatLabel,
  formatOfferPrice,
  payoutEstimate,
} from './release-display.js';

/**
 * Replace `panel`'s contents with the guide for `detail`.
 *
 * @param {HTMLElement} panel
 * @param {object} detail       The endpoint's response.
 * @param {string} fallbackUrl  Where "Open on Unstream" goes if the response carries no pageUrl.
 * @param {(url: string) => void} onOpenUrl
 */
export function renderReleaseGuide(panel, detail, fallbackUrl, onOpenUrl) {
  const children = [];

  if (detail.bandcampFriday) {
    const banner = document.createElement('div');
    banner.className = 'guide-banner';
    banner.textContent = 'Bandcamp Friday — Bandcamp is waiving its cut today.';
    children.push(banner);
  }

  const sources = detail.release?.sources || [];
  if (sources.length === 0) {
    // "We haven't looked yet" reads very differently from "you can't buy this", and only the
    // first is true here — coverage is demand-driven.
    children.push(guideMessage('Still gathering formats and prices for this release.'));
  } else {
    // Rendered in the order received. The server sorts sources artist-paying-first and each
    // source's offers cheapest-buyable-first; re-sorting here would mean carrying a copy of the
    // payout registry, which is the drift this endpoint exists to prevent.
    for (const source of sources) {
      children.push(buildGuideSource(source, onOpenUrl));
    }
  }

  const footnote = document.createElement('div');
  footnote.className = 'guide-footnote';
  footnote.textContent = 'Payout estimates use published rates, before payment processing.';
  children.push(footnote);
  children.push(guideLink('Open on Unstream', detail.pageUrl || fallbackUrl, onOpenUrl));

  panel.replaceChildren(...children);
}

function buildGuideSource(source, onOpenUrl) {
  const card = document.createElement('div');
  card.className = 'guide-source';

  const header = document.createElement('div');
  header.className = 'guide-source-header';

  const name = document.createElement('span');
  name.className = 'guide-source-name';
  name.textContent = source.name || source.platform;

  const payout = document.createElement('span');
  // A platform with no published rate says so, rather than silently looking like one whose
  // payout wasn't worth mentioning. Discogs is the live case: its listings are secondhand, so
  // the artist genuinely receives nothing, and that is useful information rather than something
  // to hide.
  payout.className = source.payoutPercent ? 'guide-payout' : 'guide-payout guide-payout-unknown';
  payout.textContent = source.payoutPercent
    ? `${source.payoutPercent} to artist`
    : 'Payout unknown';

  const buy = document.createElement('button');
  buy.className = 'guide-buy';
  buy.textContent = 'Buy';
  buy.title = `Buy on ${source.name || source.platform}`;
  buy.addEventListener('click', () => onOpenUrl(source.url));

  header.appendChild(name);
  header.appendChild(payout);
  header.appendChild(buy);
  card.appendChild(header);

  if (!source.offers || source.offers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'guide-empty';
    // Never read and read-but-empty are different claims, and only one of them is about this
    // platform's catalog.
    empty.textContent = source.detailCheckedAt
      ? 'No formats listed'
      : 'Formats and prices not read yet';
    card.appendChild(empty);
    return card;
  }

  for (const offer of source.offers) {
    card.appendChild(buildGuideOffer(offer, source.payoutPercent));
  }
  return card;
}

function buildGuideOffer(offer, payoutPercent) {
  const isBuyable = offer.availability !== 'sold_out';

  const row = document.createElement('div');
  row.className = isBuyable ? 'guide-offer' : 'guide-offer guide-offer-unavailable';

  const format = document.createElement('span');
  format.className = 'guide-format';
  format.textContent = formatLabel(offer.format);

  const priceCol = document.createElement('span');
  priceCol.className = 'guide-price-col';

  const price = document.createElement('span');
  price.className = 'guide-price';
  price.textContent = formatOfferPrice(offer.price, offer.currency);
  priceCol.appendChild(price);

  // No payout line on something you can't buy: "≈$12 to artist" under a sold-out cassette is a
  // number about a transaction that cannot happen.
  const payoutText = isBuyable ? payoutEstimate(offer.price, offer.currency, payoutPercent) : '';
  if (payoutText) {
    const payout = document.createElement('span');
    payout.className = 'guide-offer-payout';
    payout.textContent = payoutText;
    priceCol.appendChild(payout);
  }

  row.appendChild(format);
  row.appendChild(priceCol);

  const availabilityLabel = AVAILABILITY_LABELS[offer.availability];
  if (availabilityLabel) {
    const availability = document.createElement('span');
    availability.className =
      offer.availability === 'sold_out'
        ? 'guide-availability'
        : 'guide-availability guide-availability-notice';
    availability.textContent = availabilityLabel;
    row.appendChild(availability);
  }

  return row;
}

export function guideMessage(text) {
  const div = document.createElement('div');
  div.className = 'guide-message';
  div.textContent = text;
  return div;
}

export function guideLink(text, url, onOpenUrl) {
  const button = document.createElement('button');
  button.className = 'guide-link';
  button.textContent = text;
  button.addEventListener('click', () => onOpenUrl(url));
  return button;
}
