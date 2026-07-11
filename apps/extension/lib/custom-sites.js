// User-opted, per-site playback detection (UNS-152).
//
// Lets a user turn on the generic Media Session detector for the site in the
// active tab without shipping a new store release for every new site. We request
// the host permission for just that origin, then register the existing
// common.js + generic.js content scripts there at runtime. Nothing here changes
// detection logic — it only extends *where* the generic detector can run.

// chrome.storage.local key holding the list of user-enabled origin patterns,
// e.g. ["https://fairplayer.band/*", "https://someartist.com/*"].
export const CUSTOM_SITES_KEY = 'customSites';

// Sanity cap so storage and startup reconciliation stay bounded. Nobody is
// expected to hit this — it just prevents unbounded growth.
export const MAX_CUSTOM_SITES = 100;

// The bundled scripts a dynamically-enabled site runs — the same generic
// detector the static allowlist uses. We only ever register our own files.
const CUSTOM_SITE_SCRIPTS = ['content/common.js', 'content/generic.js'];

// Stable registration id per origin so we can update/remove it later.
function registrationId(origin) {
  return `generic:${origin}`;
}

// "https://fairplayer.band/*" from any URL on that origin.
export function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

// Can we script this URL at all? Only http/https pages — chrome://, about:,
// extension, and other privileged pages can't be scripted and would reject
// permissions.request.
export function isScriptableUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// Does `url` match a manifest match pattern like "https://*.bandcamp.com/*"?
// Standard match-pattern semantics: scheme, host (with optional "*." prefix or
// bare "*"), and a glob path.
function matchesPattern(url, pattern) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const m = /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m;

  // Scheme
  const urlScheme = parsed.protocol.slice(0, -1); // drop trailing ":"
  if (scheme === '*') {
    if (urlScheme !== 'http' && urlScheme !== 'https') return false;
  } else if (scheme !== urlScheme) {
    return false;
  }

  // Host
  if (host === '*') {
    // matches any host
  } else if (host.startsWith('*.')) {
    const base = host.slice(2);
    if (parsed.hostname !== base && !parsed.hostname.endsWith('.' + base)) return false;
  } else if (host !== parsed.hostname) {
    return false;
  }

  // Path (glob against pathname + search)
  const escaped = path.split('*').map(seg => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + escaped + '$').test(parsed.pathname + parsed.search);
}

// Is this URL already covered by a built-in (statically-declared) content
// script? If so, detection is already active and we hide the Enable control.
export function isBuiltInSite(url) {
  const scripts = chrome.runtime.getManifest().content_scripts || [];
  return scripts.some(s => (s.matches || []).some(p => matchesPattern(url, p)));
}

export async function getCustomSites() {
  const { [CUSTOM_SITES_KEY]: sites = [] } = await chrome.storage.local.get(CUSTOM_SITES_KEY);
  return sites;
}

// Register the generic detector for an origin, unless it's already registered.
async function registerCustomSite(origin) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [registrationId(origin)] });
  if (existing.length > 0) return;
  await chrome.scripting.registerContentScripts([{
    id: registrationId(origin),
    matches: [origin],
    js: CUSTOM_SITE_SCRIPTS,
    runAt: 'document_idle',
    persistAcrossSessions: true, // browser re-registers on startup automatically
  }]);
}

// Enable detection for an origin: register the content script and record it in
// our own list. The caller is responsible for requesting the host permission
// (that must happen from a user gesture in the popup) before calling this.
// Returns { ok } or { ok: false, reason: 'limit' } when the cap is reached.
export async function enableSite(origin) {
  const sites = await getCustomSites();
  if (sites.includes(origin)) {
    await registerCustomSite(origin); // ensure it's actually registered
    return { ok: true };
  }
  if (sites.length >= MAX_CUSTOM_SITES) {
    return { ok: false, reason: 'limit' };
  }
  await registerCustomSite(origin);
  sites.push(origin);
  await chrome.storage.local.set({ [CUSTOM_SITES_KEY]: sites });
  return { ok: true };
}

// Disable detection for an origin: unregister the content script, revoke the
// host permission, and prune it from our list.
export async function disableSite(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [registrationId(origin)] });
  } catch {
    // Not registered — nothing to unregister.
  }
  await chrome.permissions.remove({ origins: [origin] });
  const sites = (await getCustomSites()).filter(s => s !== origin);
  await chrome.storage.local.set({ [CUSTOM_SITES_KEY]: sites });
}

// Reconcile stored origins, granted permissions, and live registrations so they
// don't drift apart (e.g. the user revoked a permission via browser settings,
// or a registration went missing). Run on install and browser startup.
export async function reconcileCustomSites() {
  const sites = await getCustomSites();
  if (sites.length === 0) return;

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map(s => s.id));

  const survivors = [];
  for (const origin of sites) {
    const hasPermission = await chrome.permissions.contains({ origins: [origin] });

    if (!hasPermission) {
      // User revoked the permission out-of-band — drop the orphaned registration.
      if (registeredIds.has(registrationId(origin))) {
        try {
          await chrome.scripting.unregisterContentScripts({ ids: [registrationId(origin)] });
        } catch {
          // ignore
        }
      }
      continue; // prune from list
    }

    // Permission still granted — make sure the script is registered.
    if (!registeredIds.has(registrationId(origin))) {
      try {
        await registerCustomSite(origin);
      } catch {
        // Registration failed; keep it in the list to retry next reconcile.
      }
    }
    survivors.push(origin);
  }

  if (survivors.length !== sites.length) {
    await chrome.storage.local.set({ [CUSTOM_SITES_KEY]: survivors });
  }
}
