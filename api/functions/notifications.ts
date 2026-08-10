// Transactional email notifications: account-lifecycle events (claim approved/rejected) and
// saved-artist fan alerts (new release, new platform link). Wraps sendTransactionalEmail with
// an idempotency guard so a retried request, a second admin click, or a second sweep pass
// can't send the same notification to the same person twice.
//
// email_log is the source of truth for "did we already send this": the insert's unique
// constraint on (notification_type, reference_id, recipient_email) is what makes the guard
// atomic under concurrent calls, not an application-level check-then-send race.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactionalEmail } from '../lib/resend';
import { Sentry } from '../lib/sentry';
import { escapeHtml } from '../lib/html';
import { PLATFORMS } from '../shared/platform-registry';
import { formatReleaseDate, payoutRank } from '../shared/release-display';

interface NotifyOnceParams {
  client: SupabaseClient;
  notificationType: string;
  referenceId: string;
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
  /** Extra MIME headers — SUBSCRIPTION_EMAIL_HEADERS for anything with an opt-out toggle. */
  headers?: Record<string, string>;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Sends a transactional email at most once per (notificationType, referenceId). Failures —
 * duplicate send, missing API key, Resend error — are logged to Sentry and swallowed; a
 * notification email is never allowed to fail the request that triggered it.
 */
export async function sendNotificationOnce(params: NotifyOnceParams): Promise<void> {
  const { client, notificationType, referenceId, recipientEmail, subject, html, text, headers } = params;

  const { data: logRow, error: insertError } = await client
    .from('email_log')
    .insert({
      notification_type: notificationType,
      reference_id: referenceId,
      recipient_email: recipientEmail,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      // Already sent (or in flight) for this reference — the guard working, not a failure.
      return;
    }
    Sentry.captureException(insertError, {
      extra: { context: 'sendNotificationOnce.insert', notificationType, referenceId },
    });
    return;
  }

  const result = await sendTransactionalEmail({ to: recipientEmail, subject, html, text, headers });

  const { error: updateError } = await client
    .from('email_log')
    .update({
      status: result.ok ? 'sent' : 'failed',
      resend_message_id: result.messageId || null,
      error: result.error || null,
    })
    .eq('id', logRow.id);

  if (updateError) {
    Sentry.captureException(updateError, {
      extra: { context: 'sendNotificationOnce.update', notificationType, referenceId },
    });
  }

  if (!result.ok) {
    Sentry.captureMessage(`sendNotificationOnce: failed to send ${notificationType}`, {
      level: 'error',
      extra: { referenceId, error: result.error },
    });
  }
}

/**
 * user_ids of everyone currently saving an artist (tombstoned rows excluded), optionally
 * minus one user — used to skip notifying someone about their own action (e.g. the person
 * who just claimed the artist).
 */
async function getActiveSavers(client: SupabaseClient, artistId: string, excludeUserId?: string): Promise<string[]> {
  const { data, error } = await client
    .from('saved_artists')
    .select('user_id')
    .eq('artist_id', artistId)
    .eq('deleted', false);

  if (error) {
    Sentry.captureException(error, { extra: { context: 'getActiveSavers', artistId } });
    return [];
  }

  const userIds = (data as { user_id: string }[] | null || []).map(row => row.user_id);
  return excludeUserId ? userIds.filter(id => id !== excludeUserId) : userIds;
}

/**
 * Resolves auth user ids to email addresses via the admin API — saved_artists has no email
 * column of its own, unlike artist_profiles / verification_requests. One request per user,
 * which is fine at current save volumes (tens, not thousands, of savers per artist per
 * CLAUDE.md's numbers); revisit if a single artist's saver count grows large.
 */
async function resolveEmails(client: SupabaseClient, userIds: string[]): Promise<string[]> {
  const emails: string[] = [];
  for (const userId of userIds) {
    const { data, error } = await client.auth.admin.getUserById(userId);
    if (error || !data.user?.email) continue;
    emails.push(data.user.email);
  }
  return emails;
}

// ---------------------------------------------------------------------------
// Opt-out footer
// ---------------------------------------------------------------------------

/** Where every opt-out link points. SettingsPage renders the toggles under this anchor. */
const NOTIFICATION_SETTINGS_URL = 'https://unstream.stream/settings#notifications';

/**
 * RFC 2369. Mail clients turn this into their own unsubscribe affordance, and the bulk-sender
 * rules at Gmail and Yahoo expect it on anything that isn't a direct reply to something the
 * recipient just did. Deliberately not one-click (RFC 8058): that needs an unauthenticated POST
 * endpoint, and these toggles are per-user settings behind a login, so the header points at the
 * same settings page the footer does.
 *
 * Only for the emails backed by a notification_preferences column. The claim approved/rejected
 * emails answer an action the person took and have nothing to unsubscribe from.
 */
export const SUBSCRIPTION_EMAIL_HEADERS: Record<string, string> = {
  'List-Unsubscribe': `<${NOTIFICATION_SETTINGS_URL}>`,
};

/**
 * The footer every subscription email ends with: who sent it, why this person is getting it, and
 * how to stop. `reason` completes the sentence "You're receiving this because …" and is escaped
 * on the HTML side, so it can carry an artist name.
 */
export function subscriptionFooter(reason: string): { html: string; text: string } {
  return {
    html:
      '<hr style="border:none;border-top:1px solid #e0e0e0;margin:32px 0 12px">' +
      '<p style="margin:0;font-size:12px;line-height:1.6;color:#666666">' +
      `You're receiving this because ${escapeHtml(reason)}.<br>` +
      `<a href="${NOTIFICATION_SETTINGS_URL}">Manage your email notifications</a> ` +
      'to change which of these Unstream sends you, or turn them off entirely.<br>' +
      'Unstream · <a href="https://unstream.stream">unstream.stream</a>' +
      '</p>',
    text:
      `\n\n—\nYou're receiving this because ${reason}.\n` +
      `Manage your email notifications, or turn them off entirely: ${NOTIFICATION_SETTINGS_URL}\n` +
      'Unstream · https://unstream.stream',
  };
}

export type NotificationPreferenceColumn = 'new_release' | 'new_platform_link' | 'weekly_analytics_recap';

/**
 * Drops user ids who have explicitly turned this notification off. A user with no row in
 * notification_preferences has never touched their settings and is treated as enabled — see
 * the migration comment. A lookup failure fails *open* (keeps everyone) rather than closed:
 * silently suppressing a notification someone opted into by default is the "cache uncertainty
 * as a negative" mistake this codebase specifically avoids elsewhere, and it would look
 * identical to nothing being wrong.
 */
export async function filterByPreference(
  client: SupabaseClient,
  userIds: string[],
  column: NotificationPreferenceColumn,
): Promise<string[]> {
  if (userIds.length === 0) return userIds;

  const { data, error } = await client
    .from('notification_preferences')
    .select(`user_id, ${column}`)
    .in('user_id', userIds);

  if (error) {
    Sentry.captureException(error, { extra: { context: 'filterByPreference', column } });
    return userIds;
  }

  const optedOut = new Set(
    (data as Record<string, unknown>[] | null || [])
      .filter(row => row[column] === false)
      .map(row => row.user_id as string),
  );
  return userIds.filter(id => !optedOut.has(id));
}

interface NewReleaseParams {
  client: SupabaseClient;
  artistId: string;
}

/** How many of the new releases get named in the email before it falls back to "and N more". */
const MAX_LISTED_RELEASES = 5;

/**
 * How recently a release must have come out for the alert to treat it as news. Anything older is
 * a catalogue gap we have only just filled, not something that happened.
 */
const RECENT_RELEASE_WINDOW_DAYS = 7;

interface NewReleaseSummary {
  id: string;
  title: string;
  slug: string;
  /** "12 August 2026", "August 2026", "2026" — or '' for an upcoming release with no date yet. */
  dateText: string;
  /** Display names, artist-paying platforms first. */
  platforms: string[];
}

interface ClaimedRow {
  id: string;
  title: string;
  slug: string;
  release_date: string | null;
  date_precision: string | null;
  status: string;
  created_at: string;
}

/** Newest release date first, undated last, ties broken by the order we discovered them. */
function byNewest(a: ClaimedRow, b: ClaimedRow): number {
  if (a.release_date !== b.release_date) {
    if (!a.release_date) return 1;
    if (!b.release_date) return -1;
    return a.release_date < b.release_date ? 1 : -1;
  }
  return a.created_at < b.created_at ? 1 : -1;
}

/**
 * Whether a release is worth emailing about: out in the last week, or still to come.
 *
 * Cataloguing discovers records, it doesn't witness them being released. A parser improvement, a
 * newly linked platform or a Discogs pass can surface an album from 1998 for the first time, and
 * to this code that looks exactly like an album published this morning. Telling somebody
 * "new release from X" about a record they may well have owned for twenty years is noise, and
 * noise in the first alerts anybody receives is the expensive kind.
 *
 * Dates are compared as ISO strings, which sort chronologically, so this needs no date parsing.
 * A future date passes on the same comparison, which is what makes an upcoming release news.
 */
function isNewsworthy(row: ClaimedRow, now: Date): boolean {
  // 'announced' means dated in the future or flagged as a pre-order upstream, and a pre-order can
  // reach us with no date at all — still the most newsworthy thing an artist does.
  if (row.status === 'announced') return true;
  if (!row.release_date) return false;

  const cutoff = new Date(now.getTime() - RECENT_RELEASE_WINDOW_DAYS * 86_400_000);
  return row.release_date >= cutoff.toISOString().slice(0, 10);
}

/**
 * Whether we know enough about a release's age to rule on it at all. An undated release could
 * be from this morning or from 1998, and the detail pass that would settle it is budgeted — so a
 * release can arrive dateless in one run and dated in the next.
 */
function canJudgeAge(row: ClaimedRow): boolean {
  return row.release_date !== null || row.status === 'announced';
}

/**
 * Takes ownership of every release for this artist that no alert has accounted for yet *and whose
 * age we can actually judge*, and returns them. The caller decides which of them are worth an
 * email; claiming is about never saying the same thing twice, not about what gets said.
 *
 * This is what stops a release being announced twice. The alert used to infer "what's new" from
 * releases_found before and after a run, and a count can't express which records those are: a run
 * that drops one release and adds two leaves the total up by one and re-announces something
 * already sent. `alert_sent_at` states it directly.
 *
 * Read first, then claim by id. The obvious version is one UPDATE with the age filter inlined,
 * but that puts the rule in a PostgREST filter string used nowhere else in this codebase, where a
 * mistake wouldn't fail — it would quietly match the wrong rows and mail them out. The decision
 * lives in canJudgeAge instead, where it is typechecked and unit-tested, and the UPDATE only has
 * to handle ids. Atomicity is unaffected: `alert_sent_at IS NULL` is still on the write, and its
 * RETURNING is still the authority, so two catalog runs racing on the same artist split the rows
 * between them rather than both claiming the lot.
 *
 * Undated releases are deliberately left unclaimed. "We don't know when this came out" is not
 * "this is old", and marking it accounted-for would cache that uncertainty as a permanent no —
 * the single most repeated bug in this codebase. It stays pending until a date settles it in
 * either direction. A release that never gets a date is therefore never announced, which is the
 * honest outcome: we have nothing to tell anyone about when it happened.
 *
 * Claiming *before* checking who (if anyone) is going to be emailed is deliberate. Releases
 * discovered while nobody was saving the artist are marked seen and never announced, so somebody
 * saving that artist a year later gets alerts from that point forward rather than a mail-out of
 * everything they missed.
 */
async function claimDatedReleases(
  client: SupabaseClient,
  artistId: string,
): Promise<ClaimedRow[]> {
  const { data, error } = await client
    .from('releases')
    .select('id, title, slug, release_date, date_precision, status, created_at')
    .eq('artist_id', artistId)
    .eq('is_hidden', false)
    .is('alert_sent_at', null);

  if (error) {
    // Nothing was claimed, so nothing is lost: report it and let the next catalog run retry.
    // Sending a vaguer email instead would be guessing at exactly the thing this claim exists
    // to know for certain.
    Sentry.captureException(error, { extra: { context: 'claimDatedReleases.read', artistId } });
    return [];
  }

  const candidates = ((data as ClaimedRow[]) || []).filter(canJudgeAge);
  if (candidates.length === 0) return [];

  const { data: claimed, error: claimError } = await client
    .from('releases')
    .update({ alert_sent_at: new Date().toISOString() })
    .in('id', candidates.map(row => row.id))
    .is('alert_sent_at', null)
    .select('id');

  if (claimError) {
    Sentry.captureException(claimError, { extra: { context: 'claimDatedReleases.claim', artistId } });
    return [];
  }

  // Only the rows this call actually won — a concurrent run may have taken some of them.
  const won = new Set(((claimed as { id: string }[]) || []).map(row => row.id));
  return candidates.filter(row => won.has(row.id)).sort(byNewest);
}

/** Adds the display detail — formatted date, platform names — to the releases being announced. */
async function toSummaries(
  client: SupabaseClient,
  rows: ClaimedRow[],
): Promise<NewReleaseSummary[]> {
  const platformsByRelease = await getPlatformsByRelease(client, rows.map(row => row.id));

  return rows.map(row => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    dateText: formatReleaseDate(row.release_date, row.date_precision),
    platforms: (platformsByRelease.get(row.id) || [])
      .sort((a, b) => payoutRank(b) - payoutRank(a))
      .map(platform => PLATFORMS[platform]?.name ?? platform),
  }));
}

/**
 * Where each of these releases can be bought. A separate read rather than an embed on the claim
 * above, because the claim is a mutation and its returned representation is the one thing that
 * must stay simple enough to trust.
 *
 * A failure here degrades the email to titles and dates instead of dropping it: the releases are
 * already claimed by this point, so returning nothing would mean they are never announced at all.
 */
async function getPlatformsByRelease(
  client: SupabaseClient,
  releaseIds: string[],
): Promise<Map<string, string[]>> {
  const byRelease = new Map<string, string[]>();

  const { data, error } = await client
    .from('release_sources')
    .select('release_id, platform')
    .in('release_id', releaseIds);

  if (error) {
    Sentry.captureException(error, { extra: { context: 'getPlatformsByRelease' } });
    return byRelease;
  }

  for (const row of (data as { release_id: string; platform: string }[] | null) || []) {
    const platforms = byRelease.get(row.release_id);
    if (platforms) platforms.push(row.platform);
    else byRelease.set(row.release_id, [row.platform]);
  }
  return byRelease;
}

/** "12 August 2026 · Available on Bandcamp, Mirlo" — whichever of the two we actually know. */
function releaseDetailLine(release: NewReleaseSummary): string {
  const parts = [release.dateText || 'Release date not listed'];
  if (release.platforms.length > 0) parts.push(`Available on ${release.platforms.join(', ')}`);
  return parts.join(' · ');
}

/**
 * Tells everyone who saved this artist about their genuinely new releases — out in the last week,
 * or still to come. Called from recordCatalogOutcome whenever releases_found increases.
 *
 * Two independent guarantees, and both have to hold for an email to go out. claimDatedReleases
 * makes sure nothing is ever announced twice; isNewsworthy makes sure nothing is announced that
 * isn't news. Everything else this run turned up is claimed and quietly filed, so it can't
 * resurface later either. Nothing to announce means no email at all.
 *
 * The date window also stands in for what used to be a separate first-catalogue special case. An
 * artist's opening crawl arrives as their entire discography, and "34 new releases" was wrong
 * about every record in it — but that is only ever true of *old* records, which the window now
 * excludes on their own merits. A first crawl that happens to include last week's single is real
 * news, and no longer suppressed for being first.
 */
export async function notifySavedArtistsOfNewRelease(params: NewReleaseParams): Promise<void> {
  const { client, artistId } = params;

  const claimed = await claimDatedReleases(client, artistId);
  const now = new Date();
  const newsworthy = claimed.filter(row => isNewsworthy(row, now));
  if (newsworthy.length === 0) return;

  let userIds = await getActiveSavers(client, artistId);
  if (userIds.length === 0) return;

  userIds = await filterByPreference(client, userIds, 'new_release');
  if (userIds.length === 0) return;

  const { data: artist, error } = await client
    .from('artists')
    .select('name, slug')
    .eq('id', artistId)
    .maybeSingle();
  if (error || !artist?.slug) {
    if (error) Sentry.captureException(error, { extra: { context: 'notifySavedArtistsOfNewRelease', artistId } });
    return;
  }

  const emails = await resolveEmails(client, userIds);
  if (emails.length === 0) return;

  const releases = await toSummaries(client, newsworthy);
  const listed = releases.slice(0, MAX_LISTED_RELEASES);
  const undisclosed = releases.length - listed.length;

  const profileUrl = `https://unstream.stream/a/${artist.slug}`;
  const footer = subscriptionFooter(`you saved ${artist.name} on Unstream`);

  // A release is claimed exactly once, so the lowest id in this batch appears in no other batch
  // — a stable, short key for email_log's per-recipient guard against a double send.
  const referenceId = `${artistId}:${releases.map(release => release.id).sort()[0]}`;

  // No trailing punctuation: the sentence is finished differently in each body below.
  const newsHtml =
    releases.length === 1
      ? `<strong>${escapeHtml(artist.name)}</strong>, an artist you saved on Unstream, has a new release`
      : `<strong>${escapeHtml(artist.name)}</strong>, an artist you saved on Unstream, has ${releases.length} new releases`;
  const newsText =
    releases.length === 1
      ? `${artist.name}, an artist you saved on Unstream, has a new release`
      : `${artist.name}, an artist you saved on Unstream, has ${releases.length} new releases`;

  const subject =
    releases.length === 1
      ? `New release from ${artist.name}: ${releases[0].title}`
      : `${releases.length} new releases from ${artist.name}`;

  const html = [
    `<p>${newsHtml}:</p>`,
    '<ul style="padding-left:18px">',
    ...listed.map(release =>
      `  <li style="margin-bottom:10px">` +
      `<a href="${profileUrl}/${escapeHtml(release.slug)}"><strong>${escapeHtml(release.title)}</strong></a><br>` +
      `<span style="color:#555555">${escapeHtml(releaseDetailLine(release))}</span></li>`,
    ),
    '</ul>',
    ...(undisclosed > 0 ? [`<p>…and ${undisclosed} more.</p>`] : []),
    `<p>See everything they've put out at <a href="${profileUrl}">${profileUrl}</a>.</p>`,
    footer.html,
  ].join('\n');

  const text = [
    `${newsText}:`,
    '',
    ...listed.map(release =>
      `- ${release.title}\n  ${releaseDetailLine(release)}\n  ${profileUrl}/${release.slug}`,
    ),
    ...(undisclosed > 0 ? ['', `…and ${undisclosed} more.`] : []),
    '',
    `See everything they've put out at ${profileUrl}.`,
  ].join('\n') + footer.text;

  for (const email of emails) {
    void sendNotificationOnce({
      client,
      notificationType: 'new_release',
      referenceId,
      recipientEmail: email,
      subject,
      html,
      text,
      headers: SUBSCRIPTION_EMAIL_HEADERS,
    });
  }
}

interface NewPlatformLinkParams {
  client: SupabaseClient;
  artistId: string;
  artistName: string;
  artistSlug: string;
  platforms: string[];
  excludeUserId?: string;
}

/**
 * Tells everyone who saved this artist (other than the person who just triggered the
 * discovery, if any) that new platform links showed up. Currently only called from the claim
 * flow's link-back verification, which discovers links once per claim — not from the
 * search/enrichment upsert paths in db.ts, since those run on every search and don't yet
 * distinguish a genuinely new link from a refreshed existing one. Wiring those in needs the
 * same before/after comparison recordCatalogOutcome uses for releases.
 */
export async function notifySavedArtistsOfNewLinks(params: NewPlatformLinkParams): Promise<void> {
  const { client, artistId, artistName, artistSlug, platforms, excludeUserId } = params;
  if (platforms.length === 0) return;

  let userIds = await getActiveSavers(client, artistId, excludeUserId);
  if (userIds.length === 0) return;

  userIds = await filterByPreference(client, userIds, 'new_platform_link');
  if (userIds.length === 0) return;

  const emails = await resolveEmails(client, userIds);
  if (emails.length === 0) return;

  const profileUrl = `https://unstream.stream/a/${artistSlug}`;
  const platformList = platforms.map(platform => PLATFORMS[platform]?.name ?? platform).join(', ');
  const referenceId = `${artistId}:${[...platforms].sort().join(',')}`;
  const footer = subscriptionFooter(`you saved ${artistName} on Unstream`);

  for (const email of emails) {
    void sendNotificationOnce({
      client,
      notificationType: 'new_platform_link',
      referenceId,
      recipientEmail: email,
      subject: `${artistName} added new places to support them`,
      html: `<p><strong>${escapeHtml(artistName)}</strong>, an artist you saved on Unstream, just added links on: ${escapeHtml(platformList)}. See them at <a href="${profileUrl}">${profileUrl}</a>.</p>${footer.html}`,
      text: `${artistName}, an artist you saved on Unstream, just added links on: ${platformList}. See them at ${profileUrl}.${footer.text}`,
      headers: SUBSCRIPTION_EMAIL_HEADERS,
    });
  }
}
