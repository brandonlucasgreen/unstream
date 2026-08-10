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
import { isAdminEmail } from '../lib/admin';
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

/**
 * The saved-artist alerts (new release, new platform link) are deliberately restricted to admin
 * recipients while their content is still being refined. They fire unattended from the catalog
 * sweep and the claim flow, so until we're happy with what they say, only people who can see and
 * fix a bad send should receive one.
 *
 * Applied *after* filterByPreference, so an opt-out still wins and stays honored when the
 * restriction is lifted. Fails closed — an unset ADMIN_EMAIL sends to nobody rather than to
 * everybody — but says so out loud, because sending nothing silently looks identical to nothing
 * having happened.
 */
function restrictToAdmins(emails: string[], notificationType: string): string[] {
  if (emails.length === 0) return emails;

  if (!process.env.ADMIN_EMAIL) {
    Sentry.captureMessage(
      `restrictToAdmins: ADMIN_EMAIL is not set, so no ${notificationType} alert was sent`,
      'error',
    );
    return [];
  }

  return emails.filter(isAdminEmail);
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
  releasesFound: number;
  previousReleasesFound: number;
}

/** How many of the new releases get named in the email before it falls back to "and N more". */
const MAX_LISTED_RELEASES = 5;

interface NewReleaseSummary {
  title: string;
  slug: string;
  /** "12 August 2026", "August 2026", "2026" — or '' when the upstream never gave us a date. */
  dateText: string;
  /** Display names, artist-paying platforms first. */
  platforms: string[];
}

/**
 * The releases this catalog run added, newest first.
 *
 * "Newest" is `created_at`, not `release_date`: persistReleases inserts rows it has never seen
 * before and updates the rest in place, so insertion order is what "new since the last run"
 * actually means. Release dates are frequently much older than that — an artist's first
 * catalogue run picks up their entire back catalogue at once — and ordering by them would name
 * the wrong records in the email.
 *
 * Returns [] on any read failure. The caller falls back to the generic wording rather than
 * dropping the alert: a detail lookup that failed is not a reason to withhold the news.
 */
async function getNewestReleases(
  client: SupabaseClient,
  artistId: string,
  count: number,
): Promise<NewReleaseSummary[]> {
  const { data, error } = await client
    .from('releases')
    .select('title, slug, release_date, date_precision, release_sources ( platform )')
    .eq('artist_id', artistId)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .limit(count);

  if (error) {
    Sentry.captureException(error, { extra: { context: 'getNewestReleases', artistId } });
    return [];
  }

  type Row = {
    title: string;
    slug: string;
    release_date: string | null;
    date_precision: string | null;
    release_sources: { platform: string }[] | null;
  };

  return ((data as unknown as Row[]) || []).map(row => ({
    title: row.title,
    slug: row.slug,
    dateText: formatReleaseDate(row.release_date, row.date_precision),
    platforms: (row.release_sources || [])
      .map(source => source.platform)
      .sort((a, b) => payoutRank(b) - payoutRank(a))
      .map(platform => PLATFORMS[platform]?.name ?? platform),
  }));
}

/** "12 August 2026 · Available on Bandcamp, Mirlo" — whichever of the two we actually know. */
function releaseDetailLine(release: NewReleaseSummary): string {
  const parts = [release.dateText || 'Release date not listed'];
  if (release.platforms.length > 0) parts.push(`Available on ${release.platforms.join(', ')}`);
  return parts.join(' · ');
}

/**
 * Tells everyone who saved this artist that a new release showed up. Called from
 * recordCatalogOutcome whenever releases_found increases; cheap to call on every catalog run
 * because it bails out before any lookup if nobody has saved the artist — true for the large
 * majority of catalogued artists (see CLAUDE.md's saved-vs-catalogued ratio).
 *
 * Currently admin-only on the way out — see restrictToAdmins.
 *
 * referenceId encodes the *count*, not just the artist, so a later increase (5 -> 8 -> 12)
 * sends a fresh notification each time instead of being deduped against the first one ever
 * sent for that artist.
 */
export async function notifySavedArtistsOfNewRelease(params: NewReleaseParams): Promise<void> {
  const { client, artistId, releasesFound, previousReleasesFound } = params;

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

  const emails = restrictToAdmins(await resolveEmails(client, userIds), 'new_release');
  if (emails.length === 0) return;

  // The count can only be inferred from the before/after totals, so floor it at one: a total
  // that went up means at least one row is new even if rows were also removed in the same run.
  const newCount = Math.max(1, releasesFound - previousReleasesFound);
  const releases = await getNewestReleases(client, artistId, Math.min(newCount, MAX_LISTED_RELEASES));
  const undisclosed = Math.max(0, newCount - releases.length);

  const profileUrl = `https://unstream.stream/a/${artist.slug}`;
  const referenceId = `${artistId}:${releasesFound}`;
  const footer = subscriptionFooter(`you saved ${artist.name} on Unstream`);

  // No trailing punctuation: the two bodies below finish the sentence differently.
  const newsHtml =
    newCount === 1
      ? `<strong>${escapeHtml(artist.name)}</strong>, an artist you saved on Unstream, has a new release`
      : `<strong>${escapeHtml(artist.name)}</strong>, an artist you saved on Unstream, has ${newCount} new releases`;
  const newsText =
    newCount === 1
      ? `${artist.name}, an artist you saved on Unstream, has a new release`
      : `${artist.name}, an artist you saved on Unstream, has ${newCount} new releases`;

  const subject =
    releases.length === 1 && newCount === 1
      ? `New release from ${artist.name}: ${releases[0].title}`
      : newCount === 1
        ? `New release from ${artist.name}`
        : `${newCount} new releases from ${artist.name}`;

  // An empty or failed detail read still sends, with the wording this email had before it
  // learned to name releases — a lookup that failed is not a reason to withhold the news.
  const html = releases.length === 0
    ? `<p>${newsHtml}. See it at <a href="${profileUrl}">${profileUrl}</a>.</p>${footer.html}`
    : [
        `<p>${newsHtml}:</p>`,
        '<ul style="padding-left:18px">',
        ...releases.map(release =>
          `  <li style="margin-bottom:10px">` +
          `<a href="${profileUrl}/${escapeHtml(release.slug)}"><strong>${escapeHtml(release.title)}</strong></a><br>` +
          `<span style="color:#555555">${escapeHtml(releaseDetailLine(release))}</span></li>`,
        ),
        '</ul>',
        ...(undisclosed > 0 ? [`<p>…and ${undisclosed} more.</p>`] : []),
        `<p>See everything they've put out at <a href="${profileUrl}">${profileUrl}</a>.</p>`,
        footer.html,
      ].join('\n');

  const text = releases.length === 0
    ? `${newsText}. See it at ${profileUrl}.${footer.text}`
    : [
        `${newsText}:`,
        '',
        ...releases.map(release =>
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
 *
 * Currently admin-only on the way out — see restrictToAdmins.
 */
export async function notifySavedArtistsOfNewLinks(params: NewPlatformLinkParams): Promise<void> {
  const { client, artistId, artistName, artistSlug, platforms, excludeUserId } = params;
  if (platforms.length === 0) return;

  let userIds = await getActiveSavers(client, artistId, excludeUserId);
  if (userIds.length === 0) return;

  userIds = await filterByPreference(client, userIds, 'new_platform_link');
  if (userIds.length === 0) return;

  const emails = restrictToAdmins(await resolveEmails(client, userIds), 'new_platform_link');
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
