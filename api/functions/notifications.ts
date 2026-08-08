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

interface NotifyOnceParams {
  client: SupabaseClient;
  notificationType: string;
  referenceId: string;
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Sends a transactional email at most once per (notificationType, referenceId). Failures —
 * duplicate send, missing API key, Resend error — are logged to Sentry and swallowed; a
 * notification email is never allowed to fail the request that triggered it.
 */
export async function sendNotificationOnce(params: NotifyOnceParams): Promise<void> {
  const { client, notificationType, referenceId, recipientEmail, subject, html, text } = params;

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

  const result = await sendTransactionalEmail({ to: recipientEmail, subject, html, text });

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
}

/**
 * Tells everyone who saved this artist that a new release showed up. Called from
 * recordCatalogOutcome whenever releases_found increases; cheap to call on every catalog run
 * because it bails out before any lookup if nobody has saved the artist — true for the large
 * majority of catalogued artists (see CLAUDE.md's saved-vs-catalogued ratio).
 *
 * referenceId encodes the *count*, not just the artist, so a later increase (5 -> 8 -> 12)
 * sends a fresh notification each time instead of being deduped against the first one ever
 * sent for that artist.
 */
export async function notifySavedArtistsOfNewRelease(params: NewReleaseParams): Promise<void> {
  const { client, artistId, releasesFound } = params;

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
  const profileUrl = `https://unstream.stream/a/${artist.slug}`;
  const referenceId = `${artistId}:${releasesFound}`;

  for (const email of emails) {
    void sendNotificationOnce({
      client,
      notificationType: 'new_release',
      referenceId,
      recipientEmail: email,
      subject: `New release from ${artist.name}`,
      html: `<p><strong>${escapeHtml(artist.name)}</strong>, an artist you saved on Unstream, has a new release up. See it at <a href="${profileUrl}">${profileUrl}</a>.</p>`,
      text: `${artist.name}, an artist you saved on Unstream, has a new release up. See it at ${profileUrl}.`,
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
  const profileUrl = `https://unstream.stream/a/${artistSlug}`;
  const platformList = platforms.join(', ');
  const referenceId = `${artistId}:${[...platforms].sort().join(',')}`;

  for (const email of emails) {
    void sendNotificationOnce({
      client,
      notificationType: 'new_platform_link',
      referenceId,
      recipientEmail: email,
      subject: `${artistName} added new places to support them`,
      html: `<p><strong>${escapeHtml(artistName)}</strong>, an artist you saved on Unstream, just added links on: ${escapeHtml(platformList)}. See them at <a href="${profileUrl}">${profileUrl}</a>.</p>`,
      text: `${artistName}, an artist you saved on Unstream, just added links on: ${platformList}. See them at ${profileUrl}.`,
    });
  }
}
