/**
 * Push notifications to the admin's phone through Pushover, for things that wait on him: an
 * artist awaiting tip approval (tips-review-notify.ts) or a claim awaiting manual verification
 * (claim-artist.ts).
 *
 * Requires PUSHOVER_APP_TOKEN (the Unstream application's token) and PUSHOVER_USER_KEY (the
 * admin's user key), both secrets in Netlify.
 *
 * Pushover replaced Brandon's self-hosted ntfy on 2026-10-27. That server sits on his Mac
 * Studio behind a Cloudflare tunnel, and the first real claim push from Netlify never reached it
 * (its publish counter didn't move) — most likely Cloudflare challenging Netlify's AWS egress,
 * the same way Bot Fight Mode challenges Lambda calls to unstream.stream. A hosted API has no
 * home machine, tunnel or bot check between a function and the phone.
 */

import { isUrlHostnameAllowed } from './middleware';

const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
const UPSTREAM_TIMEOUT_MS = 5000; // an artist may be waiting on the claim request that sent this

// Pushover rejects a message over these lengths outright, which would lose the push.
const MAX_TITLE_LENGTH = 250;
const MAX_MESSAGE_LENGTH = 1024;

export interface AdminPush {
  title: string;
  message: string;
  /** Opened from the notification. */
  url: string;
}

/** True once Pushover accepted the message. False (and logged) on missing config or any failure. */
export async function sendAdminPush(push: AdminPush): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    console.error('[admin-push] PUSHOVER_APP_TOKEN/PUSHOVER_USER_KEY not configured — cannot push');
    return false;
  }
  if (!isUrlHostnameAllowed(PUSHOVER_MESSAGES_URL)) {
    console.error('[admin-push] Pushover host is not on the outbound allowlist');
    return false;
  }
  try {
    const res = await fetch(PUSHOVER_MESSAGES_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user,
        title: push.title.slice(0, MAX_TITLE_LENGTH),
        message: push.message.slice(0, MAX_MESSAGE_LENGTH),
        url: push.url,
        url_title: 'Open in Unstream',
      }),
    });
    if (!res.ok) {
      // Pushover names the problem ("application token is invalid") without echoing the token.
      const body = await res.json().catch(() => null) as { errors?: string[] } | null;
      console.error(`[admin-push] Pushover responded ${res.status}: ${body?.errors?.join('; ') ?? 'no detail'}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[admin-push] push failed:', err instanceof Error ? err.name : err);
    return false;
  }
}
