// Bridges a magic-link sign-in completed on unstream.stream back into the extension.
// The extension can't receive the emailed link directly (it opens in whatever tab/app
// handles the user's email), so signInWithOtp() points redirectTo at /login — the same
// page the web app itself uses. When that page loads with an access_token in the
// redirect hash, this script forwards the callback URL to the background service worker,
// which stores the session (see AUTH_MAGIC_LINK_CALLBACK in background/service-worker.js).
// Runs at document_start so it reads the hash before the web app's own auth handling
// strips it from the URL.
if (window.location.hash.includes('access_token')) {
  try {
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'AUTH_MAGIC_LINK_CALLBACK', url: window.location.href });
    }
  } catch {
    // Extension context invalidated — ignore
  }
}
