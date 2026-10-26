/**
 * Push notifications to the admin's phone through Brandon's self-hosted ntfy server, for things
 * that wait on him: an artist awaiting tip approval (tips-review-notify.ts) or a claim awaiting
 * manual verification (claim-artist.ts).
 *
 * Requires NTFY_SERVER_URL, NTFY_TOPIC and NTFY_TOKEN in the environment. All three live only in
 * Netlify: the repo is public, so the server's address, the topic and the token must never be
 * written here, in a test, or in a doc. For the same reason the server isn't in
 * ALLOWED_OUTBOUND_HOSTNAMES — the URL comes from our own configuration, never from a request.
 *
 * Publishes as JSON to the server root rather than with Title/Tags headers: header values must be
 * Latin-1, so an artist name like "坂本龍一" in a Title header makes fetch throw before sending.
 */

const UPSTREAM_TIMEOUT_MS = 5000; // a healthy server answers in milliseconds; an artist may be waiting

export interface AdminPush {
  title: string;
  message: string;
  /** ntfy tags; ones matching an emoji shortcode render as that emoji. */
  tags: string[];
  /** Opened when the notification is tapped. */
  click: string;
}

/** True once ntfy accepted the message. False (and logged) on missing config or any failure. */
export async function sendAdminPush(push: AdminPush): Promise<boolean> {
  const server = process.env.NTFY_SERVER_URL;
  const topic = process.env.NTFY_TOPIC;
  const token = process.env.NTFY_TOKEN;
  if (!server || !topic || !token) {
    console.error('[ntfy] NTFY_SERVER_URL/NTFY_TOPIC/NTFY_TOKEN not configured — cannot push');
    return false;
  }
  try {
    const res = await fetch(server.replace(/\/$/, '') + '/', {
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: push.title, message: push.message, tags: push.tags, click: push.click }),
    });
    if (!res.ok) {
      console.error(`[ntfy] server responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ntfy] push failed:', err instanceof Error ? err.name : err);
    return false;
  }
}
