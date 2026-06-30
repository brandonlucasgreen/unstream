# Extension Dynamic Site Detection Spec (Tier 3)

**Status**: Proposed
**Last Updated**: June 2026
**Author**: Generated with Claude

---

## Overview

Today the Unstream browser extension only detects music playback on a hardcoded allowlist of sites baked into the `content_scripts` `matches` arrays of `manifest.json` and `manifest-firefox.json`. Adding a new site requires editing both manifests and shipping a new store release.

This spec describes **user-opted, per-site detection**: a popup control that lets a user turn on playback detection for whatever site they're currently on. The extension grants permission for just that origin and registers the existing generic Media Session content script there at runtime — no new release required to support a new site.

This is the "Tier 3" option from the playback-detection expansion discussion. It scales coverage to the long tail of small and self-hosted music players (e.g. `fairplayer.band`, an artist's own site) **without** broadening the install-time permission prompt to "all websites" and **without** sacrificing the privacy posture that the extension only runs where it's wanted.

### Goals

- Let a user enable playback detection on the site in the active tab, from the popup, in one click.
- Persist enabled sites so detection keeps working on future visits.
- Reuse the existing generic detector (`content/generic.js`) unchanged — this is a delivery mechanism, not new detection logic.
- Keep the default install permission prompt as tight as it is today (curated music-site allowlist only).
- Let a user turn a site back off and have the permission revoked.

### Non-goals

- Replacing the curated allowlist. The six bespoke per-site scripts (Spotify, YouTube, etc.) and the default generic allowlist stay exactly as they are. This is additive.
- Custom DOM scraping for user-added sites. Dynamic injection only runs the **generic Media Session detector**. A site that does not implement the Media Session API (or does not populate `artist`) will not produce results — by design (see Limitations).
- Auto-detecting "is this a music site." The user makes that call by clicking the button.

---

## User experience

### Enabling a site

1. User is on a site that plays music but isn't in the allowlist (e.g. `fairplayer.band`).
2. User opens the Unstream popup. Because the extension has no content script on this page, the popup shows an empty/idle state plus a new control:
   > **Detect music on this site?**
   > Unstream isn't watching this site yet. Turn on detection to find artists you're playing here.
   > `[ Enable on fairplayer.band ]`
3. User clicks **Enable**. The browser shows its native per-site permission prompt ("Unstream wants to read and change your data on fairplayer.band"). User accepts.
4. The extension registers `common.js` + `generic.js` on `https://fairplayer.band/*` and injects them into the current tab immediately (no reload needed). The popup switches to its normal detecting/results state.

### On return visits

The site is remembered. The content script auto-registers on extension startup, so detection "just works" the next time the user visits — identical to a built-in site.

### Disabling a site

The popup shows enabled custom sites in a small managed list (e.g. under settings or an overflow). Each has a remove control:
> `fairplayer.band  [Remove]`

Removing it unregisters the content script and revokes the host permission for that origin.

### What the user sees when a site has no Media Session support

If the user enables a site that doesn't expose Media Session metadata (or omits `artist`), detection stays idle and the popup shows a gentle explanation rather than silently doing nothing:
> Unstream is watching this site but hasn't picked up any track info. This site may not share what's playing in a way Unstream can read.

---

## Technical design

### Manifest changes

Both manifests gain an `optional_host_permissions` entry. This is what lets the extension request a specific origin at runtime **without** listing it (or `<all_urls>`) as a required permission at install time.

`manifest.json` (Chrome / MV3):
```jsonc
{
  // ...existing keys...
  "optional_host_permissions": ["https://*/*"],
  "permissions": [
    "storage",
    "activeTab",
    "alarms",
    "notifications",
    "identity",
    "scripting"        // new: required for chrome.scripting.registerContentScripts
  ]
}
```

`manifest-firefox.json` uses `optional_permissions` for hosts (Firefox folds optional host permissions into `optional_permissions`):
```jsonc
{
  // ...existing keys...
  "optional_permissions": ["https://*/*", "scripting"]
}
```

`https://*/*` as an **optional** permission does **not** trigger the scary install prompt — optional permissions are only requested, with the native browser dialog, at the moment the user clicks Enable, and always scoped down to the specific origin we ask for (see below).

### Requesting permission for one origin

When the user clicks Enable, we request only the active tab's origin, not the broad pattern:

```js
// In the popup, after resolving the active tab's origin -> e.g. "https://fairplayer.band/*"
const origin = `${new URL(tab.url).origin}/*`;
const granted = await chrome.permissions.request({ origins: [origin] });
if (!granted) return; // user declined; leave everything untouched
```

The browser dialog names only that origin. We never request `https://*/*` itself — it exists in the manifest solely to make arbitrary specific origins requestable.

### Registering the content script at runtime

Use the MV3 scripting API to persist a registration keyed by origin:

```js
async function enableSite(origin) {
  await chrome.scripting.registerContentScripts([{
    id: `generic:${origin}`,                 // stable id so we can update/remove it
    matches: [origin],
    js: ['content/common.js', 'content/generic.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true              // survives browser/extension restart
  }]);

  // Inject into the already-open tab so the user doesn't have to reload.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/common.js', 'content/generic.js']
  });
}
```

`persistAcrossSessions: true` means the browser re-registers the script automatically on every startup — no manual replay needed. We still keep our own record (below) for the management UI and for reconciliation.

### Removing a site

```js
async function disableSite(origin) {
  await chrome.scripting.unregisterContentScripts({ ids: [`generic:${origin}`] });
  await chrome.permissions.remove({ origins: [origin] });
}
```

### Source of truth & reconciliation

Store the list of user-enabled origins in `chrome.storage.local` under a single key, e.g.:
```js
{ "customSites": ["https://fairplayer.band/*", "https://someartist.com/*"] }
```

This list drives the popup's management UI. On `chrome.runtime.onInstalled` and `onStartup`, reconcile: for each stored origin, confirm the permission is still granted (`chrome.permissions.contains`) and the script is registered (`chrome.scripting.getRegisteredContentScripts`); drop any the user revoked via browser settings, and re-register any missing. This keeps storage, granted permissions, and live registrations from drifting apart.

### Source attribution

`generic.js` already derives a source name from the hostname (`getSourceName()` falls back to the bare hostname when it's not in `DOMAIN_SOURCE_MAP`). User-added sites will report their hostname (e.g. `fairplayer.band`) as the source with no extra work. If a site later graduates to "officially supported," we add it to `DOMAIN_SOURCE_MAP` for a cleaner label — but that's optional polish, not required.

---

## Firefox differences

- Firefox exposes host permissions through `optional_permissions`, not a separate `optional_host_permissions` key — already reflected above.
- `chrome.scripting.registerContentScripts` with `persistAcrossSessions` is supported in Firefox (MV3, Gecko ≥ 121, which matches our current `strict_min_version`).
- Firefox shows its own per-origin permission prompt on `permissions.request`. Behavior is equivalent; verify the prompt copy during testing.
- Both manifests must be kept in sync as they are today.

---

## Security & privacy considerations

- **No broadening of default access.** The required permissions at install are unchanged for the music-site allowlist. The only new *required* permission is `scripting`, which by itself grants no host access — it just enables the registration API. All host access is opt-in, per-origin, and user-initiated.
- **Per-origin consent.** We request only the exact origin the user is on, surfaced by the browser's own dialog. We never silently widen scope.
- **Revocable.** Users can remove a site in our UI (which revokes the permission) or via the browser's own extension settings; reconciliation honors either path.
- **Unchanged data flow.** Dynamically injected scripts run the same `common.js` + `generic.js`, which only read `navigator.mediaSession` / media elements and message the background worker. No new outbound requests, no new data collected. The background still only talks to `unstream.stream` (already in `host_permissions`).
- **No arbitrary code.** We only ever register our own bundled script files by path — never remote or user-supplied code.

---

## Edge cases

- **User declines the browser prompt.** No-op; nothing stored or registered. Popup returns to the idle "Enable" state.
- **Site already in the built-in allowlist.** Hide the Enable control — detection is already active via the static content script. Detect this by checking the active origin against the known match patterns.
- **`chrome://`, `about:`, extension, and other privileged pages.** Hide the Enable control; these origins can't be scripted and `permissions.request` will reject.
- **Site enabled but no Media Session data.** Detection stays idle; show the "hasn't picked up any track info" message rather than implying failure.
- **Permission revoked in browser settings out-of-band.** Reconciliation on startup unregisters the orphaned script and prunes it from `customSites`.
- **Duplicate enable.** `registerContentScripts` throws on a duplicate `id`; guard by checking `getRegisteredContentScripts` first, or use `updateContentScripts`.

---

## Limitations

- Only sites that implement the **Media Session API and populate `artist`** will yield results (the same `title` + `artist` requirement in `common.js getFromMediaSession`). This is the identical constraint that governs the existing generic allowlist — dynamic injection doesn't change it, it just extends where the generic detector can run.
- No bespoke DOM scraping for user-added sites. If a popular site needs custom selectors, it should graduate to a dedicated content script in the curated allowlist instead.

---

## Testing

- **Chrome:** load unpacked, enable `fairplayer.band` from the popup, confirm the per-origin prompt names only that origin, confirm detection works without reload, restart the browser, confirm it still works (persistence), remove the site, confirm the script and permission are gone.
- **Firefox:** repeat with the Firefox manifest (manifest swap per our usual local-testing flow); verify the optional-permission prompt and persistence.
- **Reconciliation:** revoke the permission via browser settings, restart, confirm the orphaned registration is cleaned up and the site drops from the managed list.
- **Negative:** enable a site with no Media Session support; confirm the idle "no track info" state, not a crash or a spurious search.
- **Allowlist overlap:** confirm the Enable control is hidden on built-in sites and privileged pages.

---

## Rollout

1. Implement behind the existing popup with the new managed-sites UI.
2. Ship in a normal extension release (version bump + manual zip workflow for Chrome + Firefox stores). This is independent of the fairplayer.band allowlist PR (#304) — that PR adds fairplayer to the *static* allowlist; this feature is the general mechanism. Either can ship first.
3. Store review note: the new `https://*/*` is an **optional** host permission requested per-origin at runtime, plus `scripting`. Be ready to explain this in the store listing's permission justification, since reviewers will see the optional broad-host pattern even though it never triggers a broad install prompt.

---

## Open questions

- **Discovery:** how does a user learn this exists? Options: a one-time hint when the popup is opened on an unsupported site that's actively playing media (we can tell via `activeTab` + a quick Media Session probe), versus leaving it as a quiet power-user feature. Leaning toward a subtle inline prompt only when media is actually detected on the page, to avoid nagging.
- **Naming:** "Detect music on this site" vs. "Watch this site" vs. "Add this site." Defer to UX copy review.
- **Cap / abuse:** do we cap the number of custom sites? Probably unnecessary, but worth a sanity limit (e.g. 100) to keep storage and the startup reconciliation bounded.
