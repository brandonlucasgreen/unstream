/**
 * Draws one Instagram carousel slide (api/shared/social-card.ts says which slides exist and what
 * they say) as a 1080×1350 PNG: an SVG built here, rasterised by resvg compiled to WebAssembly.
 *
 * Why a Netlify Function and not an edge function, which the spec first suggested: edge
 * functions get 50ms of CPU per request, and on an M-series Mac resvg spent ~100ms drawing a
 * slide with a photo on it and ~30ms more encoding the PNG (2026-10-01). A text-only slide fit,
 * a photo slide was over by more than double before counting a slower server CPU. Functions have
 * no CPU cap, and running on Node also means this file is tested in CI and the handler can use
 * db.ts and the SSRF allowlist directly.
 *
 * The fonts are the site's own (OFL, licences alongside them in social-card-fonts/). They're
 * loaded into resvg directly: it has no system fonts here, and a glyph no loaded font covers
 * draws as nothing, which is why cardFontsCanDraw gates the text first.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardFontsCanDraw,
  photoSource,
  purchaseMath,
  releaseNoun,
  type CardData,
  type CardSlide,
} from '../shared/social-card.ts';

export interface CardImage {
  mimeType: 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
}

/** What a downloaded image actually is, from its first bytes. resvg decodes JPEG and PNG only. */
export function sniffImageType(bytes: Uint8Array): CardImage['mimeType'] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

// --- Fonts and the renderer, loaded once per warm instance ---
//
// Found through __dirname and require, not import.meta: Netlify bundles functions as CommonJS
// even in this "type": "module" package, and import.meta is empty there. In the deployed zip
// the fonts sit beside the bundle, as here (netlify.toml's included_files), and resvg is a whole
// package under node_modules (external_node_modules), so both paths hold in production and under
// vitest, which provides the same globals.

const FONT_FILES = ['DarkerGrotesque-ExtraBold.ttf', 'StackSansHeadline-Regular.ttf', 'StackSansHeadline-SemiBold.ttf'];

let fontBuffers: Uint8Array[] | null = null;
let wasmReady: Promise<void> | null = null;

function loadFonts(): Uint8Array[] {
  if (!fontBuffers) {
    fontBuffers = FONT_FILES.map(file => readFileSync(join(__dirname, 'social-card-fonts', file)));
  }
  return fontBuffers;
}

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  }
  return wasmReady;
}

function resvg(svg: string) {
  return new Resvg(svg, {
    font: { fontBuffers: loadFonts(), loadSystemFonts: false, defaultFontFamily: 'Stack Sans Headline' },
    fitTo: { mode: 'original' },
  });
}

// --- Type ---

interface Face {
  family: string;
  weight: number;
}

const DISPLAY: Face = { family: 'Darker Grotesque', weight: 800 };
const BODY: Face = { family: 'Stack Sans Headline', weight: 400 };
const BODY_BOLD: Face = { family: 'Stack Sans Headline', weight: 600 };

// The site's dark theme (apps/web/src/index.css).
const COLORS = {
  background: '#121212',
  card: '#1a1a1a',
  border: '#2a2a2a',
  text: '#f0f0f0',
  secondary: '#999999',
  muted: '#808080',
  accent: '#ff6b35',
};

const MARGIN = 88;
const CONTENT_WIDTH = CARD_WIDTH - MARGIN * 2;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Width scales linearly with size, so each string is measured once, at 100px.
const widthAt100 = new Map<string, number>();

function textWidth(text: string, face: Face, size: number): number {
  const key = `${face.family}|${face.weight}|${text}`;
  let width = widthAt100.get(key);
  if (width === undefined) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text y="100" font-family="${face.family}" font-weight="${face.weight}" font-size="100">${escapeXml(text)}</text></svg>`;
    width = resvg(svg).getBBox()?.width ?? 0;
    widthAt100.set(key, width);
  }
  return (width * size) / 100;
}

/** Words onto lines no wider than maxWidth. A single word wider than that gets a line of its own. */
function wrapWords(text: string, face: Face, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate, face, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface FittedText {
  size: number;
  lines: string[];
}

// Darker Grotesque's capitals are 56% of its size (measured), so a block of display text runs
// from about 0.6 of a size above its first baseline to its last baseline.
const DISPLAY_CAP_HEIGHT = 0.6;
const DISPLAY_LINE_HEIGHT = 0.86;

function displayBlockHeight(size: number, lineCount: number): number {
  return size * (DISPLAY_CAP_HEIGHT + (lineCount - 1) * DISPLAY_LINE_HEIGHT);
}

/**
 * The largest size, from maxSize down, at which the text fits in maxLines lines of maxWidth, and
 * for display text in maxHeight. At minSize it is shrunk further rather than cut: a name or title
 * is never truncated.
 */
function fitText(
  text: string,
  face: Face,
  opts: { maxWidth: number; maxLines: number; maxSize: number; minSize: number; maxHeight?: number }
): FittedText {
  for (let size = opts.maxSize; size >= opts.minSize; size = Math.floor(size * 0.94)) {
    const lines = wrapWords(text, face, size, opts.maxWidth);
    const fitsHeight = opts.maxHeight === undefined || displayBlockHeight(size, lines.length) <= opts.maxHeight;
    if (lines.length <= opts.maxLines && fitsHeight && lines.every(l => textWidth(l, face, size) <= opts.maxWidth)) {
      return { size, lines };
    }
  }
  // Still too long at the smallest size: put it on maxLines lines and scale the widest to fit.
  const words = text.split(/\s+/).filter(Boolean);
  const perLine = Math.ceil(words.length / opts.maxLines);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) lines.push(words.slice(i, i + perLine).join(' '));
  const widest = Math.max(...lines.map(l => textWidth(l, face, opts.minSize)));
  return { size: Math.floor((opts.minSize * opts.maxWidth) / widest), lines };
}

interface TextOptions {
  x: number;
  y: number;
  face: Face;
  size: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  letterSpacing?: number;
}

function text(content: string, o: TextOptions): string {
  const spacing = o.letterSpacing ? ` letter-spacing="${o.letterSpacing}"` : '';
  return `<text x="${o.x}" y="${Math.round(o.y)}" font-family="${o.face.family}" font-weight="${o.face.weight}" font-size="${o.size}" fill="${o.fill}" text-anchor="${o.anchor ?? 'start'}"${spacing}>${escapeXml(content)}</text>`;
}

/** Lines whose first baseline is at y, lineHeight apart. Returns the last baseline too. */
function textBlock(lines: string[], o: TextOptions & { lineHeight: number }): { svg: string; lastBaseline: number } {
  const svg = lines.map((line, i) => text(line, { ...o, y: o.y + i * o.lineHeight })).join('');
  return { svg, lastBaseline: o.y + (lines.length - 1) * o.lineHeight };
}

// The site's logo (apps/web/public/favicon.svg): white headphones over a greyscale emoji.
const LOGO = `<defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs><g transform="translate(22,22) scale(1.8333)" filter="url(#gs)"><path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/><ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/><path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/><path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/><path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/><ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/><path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/><path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/><path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/></g><path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="white" stroke-width="8" stroke-linecap="round"/><line x1="14" y1="52" x2="14" y2="64" stroke="white" stroke-width="7" stroke-linecap="round"/><line x1="96" y1="52" x2="96" y2="64" stroke="white" stroke-width="7" stroke-linecap="round"/><rect x="3" y="60" width="22" height="28" rx="9" fill="white"/><rect x="85" y="60" width="22" height="28" rx="9" fill="white"/>`;

/** The logo and "Unstream", top left. */
function brand(y: number): string {
  return `<svg x="${MARGIN - 6}" y="${y}" width="72" height="72" viewBox="0 0 110 110">${LOGO}</svg>`
    + text('Unstream', { x: MARGIN + 76, y: y + 50, face: BODY_BOLD, size: 40, fill: COLORS.text });
}

function footer(): string {
  return text('unstream.stream', { x: MARGIN, y: CARD_HEIGHT - 76, face: BODY, size: 32, fill: COLORS.secondary });
}

function dataUri(image: CardImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// --- The slides ---

function buySlide(data: CardData): string {
  const { platform } = data;
  // Between the kicker and the payout panel, leaving room for the location line, and centred on
  // ARTIST_TAG_POSITION (y 0.4, 540px), where the post tags the artist.
  const name = fitText(data.artistName, DISPLAY, { maxWidth: CONTENT_WIDTH, maxLines: 3, maxSize: 210, minSize: 72, maxHeight: 340 });
  const lineHeight = name.size * DISPLAY_LINE_HEIGHT;
  const firstBaseline = 540 - displayBlockHeight(name.size, name.lines.length) / 2 + name.size * DISPLAY_CAP_HEIGHT;
  const nameBlock = textBlock(name.lines, { x: MARGIN, y: firstBaseline, face: DISPLAY, size: name.size, fill: COLORS.text, lineHeight });

  const location = data.location && cardFontsCanDraw(data.location)
    // Below the descenders of the name's last line, which run about a quarter of its size.
    ? text(`from ${data.location}`, { x: MARGIN, y: nameBlock.lastBaseline + name.size * 0.28 + 52, face: BODY, size: 42, fill: COLORS.secondary })
    : '';

  const panelY = 860;
  const panel = `<rect x="${MARGIN}" y="${panelY}" width="${CONTENT_WIDTH}" height="320" rx="32" fill="${COLORS.card}" stroke="${COLORS.border}" stroke-width="2"/>`;
  let panelText: string;
  if (platform.payout) {
    const where = fitText(`of what you pay on ${platform.name}`, BODY, { maxWidth: CONTENT_WIDTH - 112, maxLines: 1, maxSize: 40, minSize: 28 });
    panelText = text(platform.payout, { x: MARGIN + 56, y: panelY + 182, face: DISPLAY, size: 200, fill: COLORS.accent })
      + text(where.lines[0], { x: MARGIN + 56, y: panelY + 238, face: BODY, size: where.size, fill: COLORS.text })
      + text('goes to the artist', { x: MARGIN + 56, y: panelY + 288, face: BODY, size: where.size, fill: COLORS.text });
  } else {
    const where = fitText(`Buy their music directly on ${platform.name}`, DISPLAY, { maxWidth: CONTENT_WIDTH - 112, maxLines: 2, maxSize: 110, minSize: 64 });
    panelText = textBlock(where.lines, { x: MARGIN + 56, y: panelY + 140, face: DISPLAY, size: where.size, fill: COLORS.text, lineHeight: where.size * DISPLAY_LINE_HEIGHT }).svg;
  }

  return brand(80)
    + text("TODAY'S ARTIST", { x: MARGIN, y: 290, face: BODY_BOLD, size: 32, fill: COLORS.accent, letterSpacing: 5 })
    + nameBlock.svg + location + panel + panelText + footer();
}

function recordSlide(data: CardData, artwork: CardImage): string {
  const release = data.release!;
  const size = 744;
  const x = (CARD_WIDTH - size) / 2;
  const y = 196;
  const cover = `<clipPath id="cover"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="24"/></clipPath>`
    + `<image x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cover)" href="${dataUri(artwork)}"/>`
    + `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="24" fill="none" stroke="${COLORS.border}" stroke-width="2"/>`;

  const noun = releaseNoun(release.type);
  const kicker = release.latest ? `Their latest ${noun} on ${data.platform.name}` : `${capitalize(noun)} on ${data.platform.name}`;
  const title = fitText(release.title, DISPLAY, { maxWidth: CONTENT_WIDTH, maxLines: 2, maxSize: 112, minSize: 60 });
  const titleBlock = textBlock(title.lines, { x: MARGIN, y: 1036 + title.size * DISPLAY_CAP_HEIGHT, face: DISPLAY, size: title.size, fill: COLORS.text, lineHeight: title.size * DISPLAY_LINE_HEIGHT });

  return brand(80) + cover
    + text(kicker, { x: MARGIN, y: 1012, face: BODY_BOLD, size: 34, fill: COLORS.accent })
    + titleBlock.svg + footer();
}

function mathSlide(data: CardData): string {
  const { platform } = data;
  const math = purchaseMath(platform.payout!)!;
  const lead = fitText(`A $10 album on ${platform.name}`, BODY_BOLD, { maxWidth: CONTENT_WIDTH, maxLines: 1, maxSize: 56, minSize: 40 });
  const footnote = wrapWords(
    `At roughly $0.003 a stream. ${platform.name} pays artists ${platform.payout} of a sale; this uses the low end.`,
    BODY, 28, CONTENT_WIDTH
  );

  return brand(80)
    + text(lead.lines[0], { x: MARGIN, y: 300, face: BODY_BOLD, size: lead.size, fill: COLORS.text })
    + text('pays them at least', { x: MARGIN, y: 372, face: BODY, size: 52, fill: COLORS.secondary })
    + text(math.take, { x: MARGIN - 8, y: 660, face: DISPLAY, size: 360, fill: COLORS.accent })
    + `<rect x="${MARGIN}" y="736" width="${CONTENT_WIDTH}" height="2" fill="${COLORS.border}"/>`
    + text("That's around", { x: MARGIN, y: 830, face: BODY, size: 44, fill: COLORS.secondary })
    + text(math.streams, { x: MARGIN - 6, y: 1010, face: DISPLAY, size: 230, fill: COLORS.text })
    + text("streams' worth", { x: MARGIN, y: 1078, face: BODY_BOLD, size: 44, fill: COLORS.text })
    + textBlock(footnote, { x: MARGIN, y: 1160, face: BODY, size: 28, fill: COLORS.muted, lineHeight: 38 }).svg
    + footer();
}

function photoSlide(data: CardData, photo: CardImage): string {
  const name = fitText(data.artistName, DISPLAY, { maxWidth: CONTENT_WIDTH, maxLines: 1, maxSize: 112, minSize: 56 });
  const source = data.imageUrl ? photoSource(data.imageUrl) : null;
  const credit = source ? `Photo from their ${source} page` : '';
  // Fitted, not cropped: artist photos come in every shape, and cropping a portrait to a square
  // cut the name off one that was a logo. A cover is square, so the record slide can crop.
  return `<image x="0" y="0" width="${CARD_WIDTH}" height="${CARD_WIDTH}" preserveAspectRatio="xMidYMid meet" href="${dataUri(photo)}"/>`
    + text(name.lines[0], { x: MARGIN, y: 1080 + 52 + name.size * DISPLAY_CAP_HEIGHT, face: DISPLAY, size: name.size, fill: COLORS.text })
    + (credit ? text(credit, { x: MARGIN, y: CARD_HEIGHT - 76, face: BODY, size: 32, fill: COLORS.secondary }) : '')
    + text('unstream.stream', { x: CARD_WIDTH - MARGIN, y: CARD_HEIGHT - 76, face: BODY, size: 32, fill: COLORS.secondary, anchor: 'end' });
}

function socialCardSvg(slide: CardSlide, data: CardData, image: CardImage | null): string {
  let body: string;
  switch (slide) {
    case 'buy': body = buySlide(data); break;
    case 'record': body = recordSlide(data, image!); break;
    case 'math': body = mathSlide(data); break;
    case 'photo': body = photoSlide(data, image!); break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`
    + `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${COLORS.background}"/>${body}</svg>`;
}

/**
 * The slide as a PNG. `image` is the cover for 'record' and the photo for 'photo'; the caller
 * has already checked the slide is one cardSlides offers for this artist.
 */
export async function renderSocialCard(slide: CardSlide, data: CardData, image: CardImage | null): Promise<Uint8Array> {
  await ensureWasm();
  return resvg(socialCardSvg(slide, data, image)).render().asPng();
}
