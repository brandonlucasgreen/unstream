// The release page's one analytics call: it counts a view of the release for the artist's
// Analytics page (`release_view:<release id>`, see api/functions/artist-activity.ts).
//
// A script in the page rather than a count taken while rendering, because the page is served
// from Netlify's CDN for an hour at a time (`cache = "manual"`, release-page.ts): a server-side
// count would see one view per hour per release, however many people came. The browser that
// actually shows the page is the only thing that knows it was viewed.
//
// It skips browsers driven by automation (`navigator.webdriver`), which is most crawlers that run
// scripts at all. Shared with Node so the escaping can be tested; the edge function imports it.

/**
 * An inline `<script>` that posts one release view. Values are JSON-encoded and every `<` is
 * escaped, so nothing in a slug can close the script element.
 */
export function releaseViewBeaconHtml(artistSlug: string, releaseId: string): string {
  const body = JSON.stringify({ slug: artistSlug, metric: `release_view:${releaseId}` }).replace(/</g, '\\u003c');
  return `<script>(function(){try{if(navigator.webdriver)return;fetch('/api/analytics/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${body}),keepalive:true}).catch(function(){})}catch(_){}})();</script>`;
}
