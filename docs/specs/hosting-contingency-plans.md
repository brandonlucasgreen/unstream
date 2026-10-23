# Hosting contingency plans

**Date:** 2026-10-23
**Decision (Brandon, 2026-10-23):** Unstream stays on Netlify, on its legacy plan, for as long as
Netlify allows it. The Cloudflare cutover is shelved: Bandcamp challenges every page request from a
Cloudflare Worker (`bandcamp-from-workers.md`). The values goal is paused. In Brandon's words,
"there's no real viable way to host Unstream in the US without compromising *something*."

This document is what to follow if one of two things happens. Neither is expected soon, and
neither needs anything done today.

## Ground rules for both scenarios

- **Never defeat a bot challenge.** No headless browsers, residential proxies, rotating addresses
  or disguised requests. Bandcamp tolerating any crawling at all is a privilege Unstream depends
  on; don't poke the bear. Degrade gracefully instead.
- **Test Bandcamp from any new host before committing to it.** It is the one thing that ruled
  Cloudflare out. A free, no-signup way to test is described below.

### How to test whether Bandcamp lets a network through

[Globalping](https://globalping.io) runs volunteer probes on many networks and needs no account.
Ask probes on the network you care about (by its AS number) to load an artist's `/music` page, then
look for Bandcamp's challenge:

```bash
curl -s -X POST https://api.globalping.io/v1/measurements -H 'Content-Type: application/json' \
  -d '{"type":"http","target":"palehound.bandcamp.com","locations":[{"magic":"AS14061","limit":3}],"measurementOptions":{"protocol":"HTTPS","request":{"method":"GET","path":"/music"}}}'
```

That returns an `id`. Fetch `https://api.globalping.io/v1/measurements/<id>` and read each
`result.rawBody` (the first 10 KB):
- a real page names the artist and has `music-grid`;
- the challenge is ~3 KB, titled "Client Challenge", and contains `/_fs-ch-`.

AS numbers: DigitalOcean `AS14061`, Amazon `AS16509`, Hetzner `AS24940`, Google `AS15169`.

**Results on 2026-10-23:**
- **DigitalOcean (New York, Amsterdam, Singapore):** real page.
- **Amazon (Boardman OR, Tokyo, Singapore):** real page.
- **Cloudflare Workers:** challenge, tested separately with `wrangler dev --remote`.

A probe makes one request with Globalping's own user agent. So a pass means "this network isn't
blocked", not "a crawler at Unstream's volume will be fine". Re-test from the actual service
before cutting over.

---

## Scenario 1: Bandcamp starts challenging Netlify (AWS)

### How we'd know

- **Sentry:** `Bandcamp /music blocked by bot challenge` (from `bandcamp-probe.ts`, at most one
  event per six hours). This is the tripwire. Make sure a Sentry alert rule notifies on it.
- **Sentry:** catalogue runs failing with `bandcamp bot challenge`, and `recordCatalogOutcome`'s
  drop-to-zero report.
- **On the site:** Bandcamp-only artists show "Unverified" with no featured release, and new
  artists come back without a Bandcamp link (exactly what staging showed on Cloudflare).
- **Quick check:** `curl -s https://unstream.stream/api/embed/bandcamp?url=https%3A%2F%2Fpalehound.bandcamp.com%2Fmusic`
  should return an `embedUrl`. A 404 `Could not find embeddable content` means Bandcamp's pages
  aren't reaching us.

### What already protects the data

Verified 2026-10-23: the current challenge page carries the `/_fs-ch-` marker that
`isBandcampChallenge` looks for.
- **The probe** returns `undecided`, which is never cached, so no artist is recorded as "not on
  Bandcamp".
- **The catalogue** throws `bandcamp bot challenge`, so the artist backs off and is retried; no
  release is wiped and no false zero is recorded.
- **Stored data keeps being served:** probe results in `bandcamp_slug_probes`, catalogued releases,
  photos, and links.

If Bandcamp ever changes the challenge page so the marker is missing, the probe still answers
`undecided` (there's no band identity in it). The catalogue would see an empty grid, so check
`release_catalog_state` for a run of zero-release successes.

### What stops working

From the feature inventory in `bandcamp-from-workers.md`:
1. Finding a new artist's Bandcamp by name.
2. Featured release and verification on Bandcamp cards.
3. Bandcamp catalogue refreshes.
4. Photo repair.
5. The live release check for uncatalogued artists.
6. The search-card preview player.
7. The claim flow's Bandcamp checks.

**Still working:** Bandcamp collection sync and cover art (the Subsonic API and image CDN weren't
challenged even from Workers), and every Bandcamp link a fan clicks.

### What to do, in order

1. **Write to Bandcamp.** Say who we are, what we fetch (artist `/music` pages and release pages,
   robots-permitted), how often, the user agent, and ask what they'd accept.
2. **Switch card data to stored-first** (option B in `bandcamp-from-workers.md`):
   - featured release and titles come from the catalogue, with a live fetch only when it misses;
   - a catalogued release counts as verification, so known artists stay "verified".
3. **For new artists, link to Bandcamp's own search.** `sources.ts` already has the template
   (`https://bandcamp.com/search?q=…`): the fan's browser does the search, as it would anyway.
   Label it as a search, not a verified link.
4. **The claim flow (#7, important):** when the Bandcamp verify-link check can't fetch the page,
   route the claim to manual review with a message saying so, rather than reporting "link not
   found". Check `claim-artist.ts` reports the difference.
5. **Pause the Bandcamp catalogue step** if it keeps failing, so it doesn't spend the crawl budget
   on challenges. Leave Discogs, Mirlo, Faircamp and Jam.coop running.
6. **Previews (#6):** play from the stored album id (`release_sources.external_id`, e.g.
   `album-1507079760`), or hide the button.

### What we won't do

Move to another host just to get past Bandcamp, or route through home connections or proxies.
If Bandcamp blocks AWS, it's telling us something about crawling in general, and the right answer
is the conversation in step 1.

---

## Scenario 2: Netlify ends the legacy plan, or usage outgrows it

### Triggers

- An email or announcement that legacy plans are ending, or a forced move to credit pricing.
- Usage approaching the legacy limits. Check **Netlify → Usage & billing**. Third-party sources put
  them at ~125,000 function calls, 100 GB of bandwidth and 300 build minutes a month, but verify:
  sources disagree on whether going over bills you or pauses the site.

### Step 1: price staying before moving

Netlify's credit plans (as of 2026-10-23): Free is 300 credits; Personal is 1,000 credits for $9 a
month. A production deploy costs **15 credits**. Main had **72 deploying pushes in the 30 days to
2026-10-23**, which is **1,080 credits on deploys alone**, before bandwidth (20 credits per GB) and
compute (10 per GB-hour).

So on today's merge habits, credit pricing means a tier above Personal. Two levers before deciding:
- **Batch merges** so several land as one deploy (see the build-budget notes).
- **Skip deploys that change nothing published.** `scripts/netlify-ignore-build.sh` already does
  this; widen it if a path can safely join.

If the price is tolerable, staying is the cheapest move: no migration at all.

### Step 2: if moving, move the app only, to an ordinary Node server

**Lead candidate: DigitalOcean App Platform, app only, with Supabase staying.** This is not the
all-DigitalOcean plan dropped on 2026-10-18; that one also moved the database and sign-in, its
biggest cost. Why this shape:
- **Bandcamp let DigitalOcean through** (the test above, 2026-10-23).
- **An always-on Node server suits a crawler:** no 10 ms or 30-second CPU limits, no 15-minute
  crawl cap, any npm package (including the social-card renderer that can't run on Workers).
- **App Platform is managed:** it deploys on git push, so there's no machine to look after.
- **Supabase, sign-in and the clients don't change;** only where the API and pages run.

Before committing:
1. Re-run the Bandcamp test from the real App Platform app (its outbound address can differ from a
   probe's), at a realistic pace.
2. Price it: a container sized for the search fan-out plus a worker for catalogue jobs. Verify
   current prices then.
3. Check that Cloudflare stays in front for DNS, CDN, the www redirect and cache purge.

### What to reuse from the removed Cloudflare Worker

The Worker port was removed on 2026-10-23, but it's in git history. The last commit on `main` with
it intact is **`9dbb9376`**: `git show 9dbb9376:workers/routes.ts`. Most of it wasn't
Cloudflare-specific:
- **`workers/routes.ts`:** the whole routing table, replacing `netlify.toml`'s redirects and edge
  entries, with a parity test (`workers/__tests__/routes.test.ts`).
- **`workers/function-adapter.ts`:** turns a standard `Request` into the Lambda-style event the
  handlers take, and their result back into a `Response`. A Node server needs exactly this.
- **`api/lib/background.ts`:** a dispatcher seam that let background jobs skip the HTTP handshake.
  On a Node host it becomes an in-process queue or a worker component.
- **`scripts/copy-worker-secrets.mjs`:** copies env values out of Netlify without displaying them,
  and detects Netlify's write-only mask.

Still in the codebase, because they hold on Netlify too:
- the edge renderers' `edgeEnv()` and their small `Context`;
- `CDN-Cache-Control`;
- `api/lib/production-site.ts` and `stripeMode()`'s live-key guard;
- every function type-checking under strict mode.

What a move would need on top: a small Node HTTP entrypoint over the routes and adapter, a job runner
for the background functions and the two schedules, and a deploy workflow.

---

## Removed on 2026-10-23

Brandon cancelled Workers Paid; the rest was deleted the same day:
- **Cloudflare:** the `unstream-staging` Worker (next.unstream.stream, its custom domain and
  secrets), the placeholder `unstream` Worker, and the four queues.
- **GitHub:** the `production` and `staging` environments and the Worker-deploy secrets.
- **The repo:** `workers/`, `wrangler.jsonc`, `deploy-worker.yml`, `scripts/copy-worker-secrets.mjs`,
  `api/lib/background.ts`, the Cloudflare cache purge, `apps/web/public/_headers` (a duplicate of
  netlify.toml's headers), and the `wrangler` and `@sentry/cloudflare` dependencies.

**Kept:** the www → apex Single Redirect rule in Cloudflare. It does what Netlify's redirect did,
earlier and at the edge.

**Brandon to revoke or remove by hand** (no API access for these):
- the "Edit Cloudflare Workers" API token and the cache-purge token;
- `https://next.unstream.stream/**` in Supabase's redirect URLs;
- the Stripe test-mode webhook endpoint for next.unstream.stream, if one was created.
