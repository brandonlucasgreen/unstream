// Scheduled job: a short welcome email from Brandon to each new account, a few hours after it
// signs up. Its real job is the one question in it, "how did you find Unstream?": nothing in the
// app records where people come from, and a reply to support@ is the cheapest honest way to ask.
//
// Invoked hourly by .github/workflows/welcome-email.yml (GitHub Actions cron, same precedent as
// tips-review-notify.yml — there are no scheduled Netlify functions in this repo), guarded by the
// internal secret so only the workflow can fire it.
//
// Who gets it: an account created between WELCOME_DELAY_HOURS and WELCOME_WINDOW_HOURS ago with a
// confirmed email address. The delay is the "few hours later" (Brandon, 2026-11-20). The upper
// bound is what keeps the first deploy from mailing every existing account, and it leaves almost a
// day of hourly runs to catch a send that a missed run skipped. An unconfirmed address is skipped:
// it may be a typo, and mailing it would land in a stranger's inbox.
//
// At most once per account: sendNotificationOnce's email_log guard ('welcome', the user id). A
// failed send stays failed, like every other notification — no retry loop.
//
// An answer to something the person just did (signing up), like the claim emails, so no opt-out
// footer: there is nothing further to unsubscribe from.

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getClient } from './db';
import { withSentry, Sentry } from '../lib/sentry';
import { sendNotificationOnce } from './notifications';
import { endpoint, type EndpointResult } from './http/endpoint';

export const WELCOME_DELAY_HOURS = 3;
export const WELCOME_WINDOW_HOURS = 24;

const WELCOME_FROM = 'Brandon from Unstream <support@unstream.stream>';
const WELCOME_REPLY_TO = 'support@unstream.stream';

/** listUsers' largest page. At ~200 accounts one page is everything; the loop is for later. */
const USERS_PER_PAGE = 1000;
/** A ceiling on pages read per run (10,000 accounts), so a pagination bug can't loop forever. */
const MAX_PAGES = 10;

const HOUR_MS = 60 * 60 * 1000;

/** True when this account should get the welcome email on a run at `now`. */
export function isDueForWelcome(user: Pick<User, 'created_at' | 'email' | 'email_confirmed_at'>, now: Date): boolean {
  if (!user.email || !user.email_confirmed_at) return false;
  const ageMs = now.getTime() - new Date(user.created_at).getTime();
  return ageMs >= WELCOME_DELAY_HOURS * HOUR_MS && ageMs < WELCOME_WINDOW_HOURS * HOUR_MS;
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

async function handleRequest(): Promise<EndpointResult> {
  const client = getClient();
  if (!client) return { status: 500, body: { error: 'Database not configured' } };

  const listed = await listAllUsers(client);
  if ('error' in listed) {
    Sentry.captureException(new Error(`welcome-email user list failed: ${listed.error}`));
    return { status: 502, body: { error: 'User list failed' } };
  }

  const now = new Date();
  const due = listed.filter(user => isDueForWelcome(user, now));

  // Sequential on purpose: a handful of sends an hour, and Resend's rate limit is per second.
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

  // Counts only: no addresses or ids in the response, which lands in the Actions log.
  return { status: 200, body: { ok: true, accounts: listed.length, due: due.length } };
}

export const handler = withSentry(endpoint({
  cors: 'none',
  methods: ['POST'],
  auth: 'internal',
  jsonBody: false,
}, handleRequest));
