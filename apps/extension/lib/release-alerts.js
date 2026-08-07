// Release alerts: which of the server's results are new, and what an alert actually says.
//
// Pure functions, split out of the service worker so they can be tested without chrome.* — and
// because every rule here already exists on the Mac side. `selectUnseenReleases` mirrors
// `ReleaseAlertManager.selectUnseen`, `releaseNotificationBody` mirrors its `notificationBody(for:)`,
// and `formatPlatformList` its `formatPlatformList`. apps/web/tests/unit/extension-release-alerts.test.ts
// pins the same cases apps/mac/UnstreamTests/ReleaseAlertTests.swift pins, so the two clients
// can't drift into saying different things about the same release.
//
// The server contract these read is documented at the top of api/functions/check-releases.ts:
// `releases[]` carries every release in the window with every platform it's on, its status, and a
// price summary. The extension used to read only the singular `release` and keep four of its
// fields, which is what all of this fixes.

import { SOURCE_CONFIG } from './constants.js';

/** Never ask for a narrower window than the server's own default. */
export const MIN_SINCE_DAYS = 31;
/** The server caps the window here too; asking for more is silently clamped. */
export const MAX_SINCE_DAYS = 365;
/**
 * Slack on top of the elapsed time. A release can be dated a few days before it is catalogued,
 * and the check that "last ran" a week ago may itself have failed partway through, so asking for
 * exactly the elapsed window leaves a seam at its edge.
 */
export const SINCE_DAYS_PADDING = 7;

/**
 * How far back this check should ask the server to look.
 *
 * Without this the extension took the server's 31-day default, so a browser closed for six weeks
 * came back and permanently missed everything that had aged out in the meantime — the check found
 * nothing, recorded a fresh `lastCheckDate`, and never looked at that period again.
 */
export function sinceDaysForCheck(lastCheckDate, now = Date.now()) {
  const elapsedDays = (now - lastCheckDate) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return MIN_SINCE_DAYS;

  const asked = Math.ceil(elapsedDays) + SINCE_DAYS_PADDING;
  return Math.min(Math.max(asked, MIN_SINCE_DAYS), MAX_SINCE_DAYS);
}

/**
 * Every release the server reported, from either of its two shapes.
 *
 * `releases` is what the catalog path returns and is the one to read: it holds an artist's second
 * record in the window, which the singular `release` cannot. The fallback to `release` covers a
 * response from an older deploy rather than being the normal path.
 */
export function releasesFromResponse(result) {
  if (!result) return [];
  if (Array.isArray(result.releases)) return result.releases;
  return result.release ? [result.release] : [];
}

/**
 * Which of these results haven't we alerted on before? Marks each one it returns as known.
 *
 * **This is the only dedup point**, exactly as on the Mac. Identity is the release name, compared
 * across platforms so one record on both Bandcamp and Mirlo is one alert rather than two — but
 * *within* an artist, so a second, different record is always new.
 *
 * The old service worker read only `result.release`, took the newest release and marked that one
 * known. An artist's second record in the window was therefore unreachable: by the next check the
 * newest was already known, and nothing ever looked past it. That loses the release permanently,
 * which is why this iterates everything the server sent.
 *
 * `knownReleases` is the persisted map (artist name, lowercased → known releases) and is mutated
 * in place, mirroring the Swift's `inout` state.
 */
export function selectUnseenReleases(results, artistName, knownReleases) {
  const key = artistName.toLowerCase();
  if (!knownReleases[key]) knownReleases[key] = [];
  const known = knownReleases[key];

  const fresh = [];

  for (const result of results) {
    if (!result || !result.releaseName) continue;

    const alreadyKnown = known.some(
      kr => kr.releaseName.toLowerCase() === result.releaseName.toLowerCase()
    );
    if (alreadyKnown) continue;

    known.push({
      releaseName: result.releaseName,
      releaseDate: result.releaseDate,
      platform: result.platform,
    });

    fresh.push({
      id: crypto.randomUUID(),
      artistName,
      releaseName: result.releaseName,
      releaseDate: result.releaseDate,
      releaseUrl: result.releaseUrl,
      platform: result.platform,
      // The three fields the old code dropped. `platforms` is the payout comparison — a record on
      // Bandcamp and Mirlo said "Bandcamp" and the fan never learned about the other. `status`
      // stopped an alert claiming a future-dated record is "out now". `offerSummary` was already
      // being *read* by the popup while nothing wrote it, so it rendered the fallback copy
      // instead of a price.
      platforms:
        Array.isArray(result.platforms) && result.platforms.length > 0
          ? result.platforms
          : [result.platform],
      status: result.status || 'released',
      offerSummary: result.offerSummary || '',
      detectedAt: new Date().toISOString(),
    });
  }

  return fresh;
}

/** A release dated in the future. It is announced, not out. */
export function isUpcomingRelease(release) {
  return release.status === 'announced';
}

/**
 * A platform's proper name. SOURCE_CONFIG renders "Jam.coop" and "Ko-fi", which plain
 * capitalization mangles into "Jamcoop" and "Kofi". An id it doesn't list at least gets a capital
 * letter rather than being dropped.
 */
export function platformDisplayName(platform) {
  if (SOURCE_CONFIG[platform]?.name) return SOURCE_CONFIG[platform].name;
  return platform ? platform[0].toUpperCase() + platform.slice(1) : '';
}

/**
 * "Bandcamp", "Bandcamp and Mirlo", "Bandcamp, Mirlo and 2 more" — a notification body has very
 * little room, so a long list is summarized rather than truncated mid-name.
 */
export function formatPlatformList(platforms) {
  const names = (platforms || []).filter(Boolean).map(platformDisplayName);

  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * "1 September". Day and month only, matching the Mac's wording for an announced release.
 *
 * Parsed and formatted in UTC: a stored date is a plain calendar date, and reading it in a
 * negative-offset zone would shift a 1 September release to 31 August.
 */
function announcedDate(date) {
  if (!date) return '';
  const [year, month, day] = String(date).split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';

  const monthName = new Date(Date.UTC(year, month - 1, day))
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `${day} ${monthName}`;
}

/**
 * Every platform an alert names.
 *
 * An alert stored by an earlier build has no `platforms` field at all — it kept only the one the
 * alert leads with — so fall back to that rather than dropping the platform from the line
 * entirely on upgrade. Mirrors how `NewRelease` decodes an old alert on the Mac.
 */
function alertPlatforms(release) {
  return Array.isArray(release.platforms) && release.platforms.length > 0
    ? release.platforms
    : [release.platform].filter(Boolean);
}

/**
 * What an alert says about a release, without repeating its name:
 *
 *   out now on Bandcamp and Mirlo · from $8 · ≈$6.80 to artist
 *   announced for 1 September on Bandcamp
 *
 * Nothing is invented. No price yet means the clause is omitted rather than filled with a
 * placeholder, and a release with no platforms at all still gets an honest "out now".
 */
export function releaseSummaryLine(release) {
  const parts = [];
  const where = formatPlatformList(alertPlatforms(release));

  if (isUpcomingRelease(release)) {
    const date = announcedDate(release.releaseDate);
    const announced = date ? `announced for ${date}` : 'announced';
    parts.push(where ? `${announced} on ${where}` : announced);
  } else {
    parts.push(where ? `out now on ${where}` : 'out now');
  }

  if (release.offerSummary) parts.push(release.offerSummary);

  return parts.join(' · ');
}

/**
 * The notification body. Was `"X" is out now on Bandcamp!` — one platform, no price, and a flat
 * falsehood about a record that isn't out yet.
 */
export function releaseNotificationBody(release) {
  return `"${release.releaseName}" — ${releaseSummaryLine(release)}`;
}

/** "Kid Lightbulbs — coming soon" for an announced release, matching the Mac. */
export function releaseNotificationTitle(release) {
  return isUpcomingRelease(release)
    ? `${release.artistName} — coming soon`
    : `New Release from ${release.artistName}`;
}
