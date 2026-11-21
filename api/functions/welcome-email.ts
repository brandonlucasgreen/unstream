// Scheduled job: a short welcome email from Brandon to each new account, about 15 minutes after it
// signs up. Its real job is the one question in it, "how did you find Unstream?": nothing in the
// app records where people come from, and a reply to support@ is the cheapest honest way to ask.
//
// Run every 5 minutes by Netlify's scheduler (the `schedule` under [functions."welcome-email"] in
// netlify.toml), so it goes out 15 to 20 minutes after sign-up. It started on an hourly GitHub
// Actions cron with a three-hour delay, but GitHub runs a schedule hours late under load (a
// 30-minute cron here once ran 2 to 8 hours apart), and once the email was a thank-you rather
// than a follow-up, "a few minutes later" had to mean that (Brandon, 2026-11-21).
//
// It is the one scheduled Netlify function in this repo. A scheduled function can't be called by
// URL and only fires on the published production deploy, never on a preview, which is why it
// takes `auth: 'none'`: nothing but the scheduler can reach it. If it ever stops being scheduled
// and is called over HTTP again, it must go back to `auth: 'internal'`.
// welcome-email.test.ts fails if the schedule leaves netlify.toml.
//
// Who gets it: an account created between WELCOME_DELAY_MINUTES and WELCOME_WINDOW_HOURS ago with
// a confirmed email address. The upper bound is what keeps the first deploy from mailing every
// existing account, and it catches someone who confirms their address hours after signing up.
// An unconfirmed address is skipped: it may be a typo, and mailing it would land in a stranger's
// inbox.
//
// At most once per account. Each run reads email_log first and only tries the accounts it
// doesn't list; sendNotificationOnce's unique key ('welcome', the user id) stays the guarantee.
// The read is there because an account sits in the window for a day, about 280 runs: leaning on
// the unique key alone would make every one of those runs a failed insert, a dead row each time.
// A failed send stays failed, like every other notification — no retry loop.
//
// An answer to something the person just did (signing up), like the claim emails, so no opt-out
// footer: there is nothing further to unsubscribe from.

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getClient } from './db';
import { withSentry, Sentry } from '../lib/sentry';
import { sendNotificationOnce } from './notifications';
import { endpoint, type EndpointResult } from './http/endpoint';

export const WELCOME_DELAY_MINUTES = 15;
export const WELCOME_WINDOW_HOURS = 24;

const WELCOME_FROM = 'Brandon from Unstream <support@unstream.stream>';
const WELCOME_REPLY_TO = 'support@unstream.stream';

/** listUsers' largest page. At ~200 accounts one page is everything; the loop is for later. */
const USERS_PER_PAGE = 1000;
/** A ceiling on pages read per run (10,000 accounts), so a pagination bug can't loop forever. */
const MAX_PAGES = 10;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** True when this account should get the welcome email on a run at `now`. */
export function isDueForWelcome(user: Pick<User, 'created_at' | 'email' | 'email_confirmed_at'>, now: Date): boolean {
  if (!user.email || !user.email_confirmed_at) return false;
  const ageMs = now.getTime() - new Date(user.created_at).getTime();
  return ageMs >= WELCOME_DELAY_MINUTES * MINUTE_MS && ageMs < WELCOME_WINDOW_HOURS * HOUR_MS;
}

export const WELCOME_SUBJECT = 'Welcome to Unstream! (+ one quick question)';

export const WELCOME_TEXT =
  'Hi there!\n\n' +
  'Thanks for signing up for Unstream. It means a lot! My goals with Unstream are to get more funds into the hands ' +
  'of artists, and slowly change how people think about supporting the arts.\n\n' +
  'One question: how did you find Unstream? A friend, a post, a search, an artist pointing you here? ' +
  'I would love to know.\n\n' +
  "And if something's broken or missing, or you have an idea to make Unstream better, reply with that too.\n\n" +
  'Thanks so much!\n' +
  'Brandon / Unstream';

export const WELCOME_HTML =
  '<p>Hi there!</p>' +
  '<p>Thanks for signing up for Unstream. It means a lot! My goals with Unstream are to get more funds into the hands ' +
  'of artists, and slowly change how people think about supporting the arts.</p>' +
  '<p><strong>One question: how did you find Unstream?</strong> A friend, a post, a search, an artist pointing you here? ' +
  'I would love to know.</p>' +
  "<p>And if something's broken or missing, or you have an idea to make Unstream better, reply with that too.</p>" +
  '<p>Thanks so much!<br>Brandon / Unstream</p>';

async function listAllUsers(client: SupabaseClient): Promise<User[] | { error: string }> {
  const users: User[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) return { error: error.message };
    users.push(...data.users);
    if (data.users.length < USERS_PER_PAGE) return users;
  }
  // Ran out of pages before running out of users: say so rather than quietly missing people.
  Sentry.captureMessage(`[welcome-email] stopped after ${MAX_PAGES} pages of users; raise MAX_PAGES`, 'warning');
  return users;
}

/** The ids among `userIds` that email_log already holds a welcome for (sent, sending or failed). */
async function alreadyWelcomed(client: SupabaseClient, userIds: string[]): Promise<Set<string> | { error: string }> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await client
    .from('email_log')
    .select('reference_id')
    .eq('notification_type', 'welcome')
    .in('reference_id', userIds);
  if (error) return { error: error.message };
  return new Set((data ?? []).map(row => row.reference_id as string));
}

async function handleRequest(): Promise<EndpointResult> {
  const client = getClient();
  if (!client) return { status: 500, body: { error: 'Database not configured' } };

  const listed = await listAllUsers(client);
  if ('error' in listed) {
    Sentry.captureException(new Error(`welcome-email user list failed: ${listed.error}`));
    return { status: 502, body: { error: 'User list failed' } };
  }

  const now = new Date();
  const inWindow = listed.filter(user => isDueForWelcome(user, now));

  const welcomed = await alreadyWelcomed(client, inWindow.map(user => user.id));
  if ('error' in welcomed) {
    // Send nothing rather than fall back to failed inserts; the next run is five minutes away.
    Sentry.captureException(new Error(`welcome-email email_log read failed: ${welcomed.error}`));
    return { status: 502, body: { error: 'Email log read failed' } };
  }
  const due = inWindow.filter(user => !welcomed.has(user.id));

  // Sequential on purpose: a handful of sends a day, and Resend's rate limit is per second.
  for (const user of due) {
    await sendNotificationOnce({
      client,
      notificationType: 'welcome',
      referenceId: user.id,
      recipientEmail: user.email as string,
      subject: WELCOME_SUBJECT,
      html: WELCOME_HTML,
      text: WELCOME_TEXT,
      from: WELCOME_FROM,
      replyTo: WELCOME_REPLY_TO,
    });
  }

  // Counts only: no addresses or ids in the response, which lands in the function log.
  return { status: 200, body: { ok: true, accounts: listed.length, due: due.length } };
}

// The scheduler's request carries only `{ next_run }`, which this doesn't need. Both methods are
// listed so a scheduler that sent GET couldn't be turned away with a 405 nobody would see.
export const handler = withSentry(endpoint({
  cors: 'none',
  methods: ['GET', 'POST'],
  auth: 'none',
  rateLimit: 'none',
  jsonBody: false,
}, handleRequest));
