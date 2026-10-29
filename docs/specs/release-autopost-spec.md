# Release autopost: a steady drumbeat for your music, without living on social media

**Status:** proposed 2026-10-28, reframed 2026-10-29 around a steady weekly rhythm rather than release announcements, with release campaigns as a manual companion feature built alongside it (Brandon). Nothing is built. It replaces curator posts as the Buffer feature being worked on (that one is paused indefinitely; see "Where this came from"). "Build plan" lists the order, and Brandon's own catalogue as Kid Lightbulbs comes first. Analytics per release is the second milestone, in `release-autopost-analytics-spec.md`; the one part of it built here is Buffer's read scope (see "Reused from curator posts").

## The goal

**An artist posts about their music consistently, at a rhythm they choose, with almost no ongoing effort.**

A verified artist connects their Buffer account, picks channels and says how many posts a week they want. Unstream recommends a number based on how many releases it has catalogued for them. From then on, each week's posts are filled automatically from what's worth saying, in this order:

1. **A campaign:** Bandcamp Friday.
2. **A release moment:** a pre-order, release day, or a new release's first weeks.
3. **The catalogue:** an older release, chosen so nothing repeats too soon.
4. **A call for support:** occasionally, linking to the artist's Unstream page.

Most weeks most artists have nothing new, and that's the case this is built for. The rhythm is deliberately gentle, one to three posts a week, so it leaves room for whatever the artist posts themselves.

**A new release needs more than the rhythm gives it,** so a companion feature, **release campaigns**, lets the artist plan a short, more intense run of posts they write themselves, with Unstream supplying the timeline and the facts. It's manual by design and built alongside autopost (see "Release campaigns").

What it solves:

- **Artists don't want to live on social media.** Staying visible means being online, so most indie artists post on release day and then go quiet. This keeps their catalogue in front of people without them opening an app.
- **The platforms that pay artists best have no social tools.** Bandcamp, Mirlo, Faircamp and Jam.coop give you a release page, with no scheduling, no reminders and no Bandcamp Friday nudge. Unstream already knows every release on all of them.
- **It sends fans to the places that pay.** Every post links to the release's Unstream page, which lists every place to buy it and what the artist keeps at each.

## No LLM writes the posts

**Every post is built by deterministic rules from templates and facts.** No language model takes part in choosing or writing what gets posted (Brandon, 2026-10-29). Artists are rightly wary of anything that writes in their voice, and Unstream's own stance on AI points the same way. "Your words, on a schedule" is something an artist can trust.

It also buys three practical things:

- **The preview is exact.** Same catalogue, same templates, same date: same post. The settings page can show the next few weeks precisely as they will go out.
- **It can be tested.** The rotation and the template filler are plain functions, unit-tested like `search-utils.ts`.
- **It costs nothing per post** and can't drift.

This rule covers the posting path only. Code written with help from AI tools is unaffected.

## Why an artist would use it

The test curator posts failed: why would someone stop what they're doing and come here? The answer has to be "they barely have to come at all."

- **It's set up once and then it runs.** Connect Buffer, tick channels, accept the recommended rhythm, look over the templates: about five minutes. There's no approval step afterwards (see "The artist stays in charge").
- **Nothing else knows the catalogue.** Buffer can schedule posts but has nothing to put in them. It doesn't know when a Bandcamp release went up, which record hasn't been mentioned in two months, or that today is Bandcamp Friday.
- **It uses their own images.** Their release covers and their own photo, which Unstream already has, plus anything they choose to upload. Never a look Unstream designed. That avoids the brand problem that sank curator posts with venues.

**What would show it's wrong:** artists switch it off within a few weeks, or delete the posts in Buffer, or the posts reach nobody. All three can be measured (see "Measuring it"). The first test is Brandon's own catalogue, then a handful of verified artists asked personally, before anything is announced.

## Where this came from

The curator posts spec listed "auto-announce an artist's own releases" under *Considered and dropped*, for three reasons:

| Then | Now |
|---|---|
| "Artists already run their own profiles" | They post on release day and go quiet. This covers the weeks between releases, and an artist chooses how much of it they want. |
| "Unstream finds releases only after they're live" | That matters less now that release announcements aren't the point. Pre-orders still come through as `announced` releases, and a release found late gets an "out now" post (see "Catching releases in time"). |
| "Lead gen for Buffer more than value for artists" | Buffer is the means. Its free plan covers three channels. The rotation and templates live in Unstream, so another poster could replace Buffer if it ever became the barrier. |

**Curator posts are paused indefinitely (Brandon, 2026-10-28; confirmed 2026-10-29), and no more of it will be built.** There was no clear reason a promoter would switch to it, and venues have brand and artwork rules that Unstream-drawn cards can't follow without uploads. Its code is merged and stays live behind the `curatorPosts` flag. Its Buffer connection is reused here (see "Reused from curator posts").

## Who can use it

- **Verified artists only:** a claim with `verified_at` set, managed from `/artist-edit/:slug`. These posts are in the artist's own name.
- **Behind the `releaseAutopost` flag,** which fails closed, with the admin account let through (`canUseReleaseAutopost`, `api/functions/release-autopost-access.ts`). **Every endpoint, page and scheduled run checks it first**, so while the flag is off the whole feature is Brandon's alone (2026-10-29). The flag is on `/admin/flags`.
- **Off until the artist switches it on,** for each artist profile separately. A manager running two bands sets up each.

## How often: the weekly rhythm

**The artist chooses posts per week, from 1 to 7. Unstream recommends a number from the size of their catalogue, and the recommendation is the default** (Brandon, 2026-10-29):

| Qualifying releases | Recommended per week |
|---|---|
| 1–7 | 1 |
| 8–14 | 2 |
| 15 or more | 3 |

That's `min(3, ceil(releases / 7))`. It's deliberately gentle, for two reasons:

- **It leaves room for the artist's own posting.** Autopost is meant to run underneath their feed, not to become it.
- **A small catalogue posted often just repeats itself,** which reads as a bot and wears out followers. At these rates even a seven-release catalogue comes round each record about every seven weeks.

More than three a week is allowed but never recommended. A release that needs more attention gets a campaign (see "Release campaigns"), not a faster rhythm.

- **"Recommended" is a setting of its own, and the default.** An artist who keeps it gets a rhythm that steps up as their catalogue grows. An artist who picks a number keeps that number.
- **The setup screen explains the choice in their terms:** "You have 4 releases. At once a week, each comes round about once a month."
- **Days are fixed by the number,** so the artist doesn't have to choose them: 1 → Fri · 2 → Tue, Fri · 3 → Mon, Wed, Fri · 4 → Mon, Wed, Fri, Sun · 5 → Mon–Fri · 6 → Mon–Sat · 7 → every day. Friday is in every pattern because it's release day and Bandcamp Friday. The timezone comes from the browser.
- **Posting time: "Recommended" is the artist's Buffer queue** (Brandon, 2026-10-29), and it's the default. Buffer's API has no "recommended time" mode, but a channel's queue slots are set by default from Buffer's own recommended posting times, so `addToQueue` is the recommendation. A queued post is handed to Buffer **on its planned day**, not 72 hours ahead, or the queue would place it days early. The trade: it shows in Buffer only on the day. The artist can choose a set time instead, which schedules exactly then and arrives in Buffer three days ahead.

## Filling each slot

Each week has as many slots as the artist chose. Slots are filled in priority order, and **the weekly number is a promise:** a busy week doesn't post more, it posts the most important things.

1. **Fixed-date posts** go on their date and take that week's nearest slot:
   - **Bandcamp Friday** (`BANDCAMP_FRIDAY_DATES`), about their newest release on Bandcamp.
   - **Release day,** for a release with a day-precision date caught before the day.
2. **Release moments** take the next free slots, newest release first:
   - **Pre-order:** an `announced` release at least three days out.
   - **Out now:** a release found already out, within 14 days of release, that missed its release-day post.
   - **Still new:** a release in its first 6 weeks, at most one slot in two.
3. **The catalogue** fills what's left. It picks the qualifying release mentioned longest ago (never mentioned counts as longest), with ties going to the newest. A release is never mentioned twice inside its spacing, which is `max(14 days, the catalogue's natural gap)`.
4. **A call for support** replaces a catalogue post at most once every 4 posts, and only at 3 or more posts a week. Below that every slot belongs to the music. It links to their Tip page if they take tips, otherwise their artist page (`unstream.stream/a/{artist}`).

**A release with a campaign is left to the campaign.** Autopost writes no release-moment or catalogue posts about it while the campaign runs, and leaves any day the campaign posts on empty. That way no day gets two posts and nothing is said twice. Releases without a campaign still get the automatic moments above, inside the weekly number.

**Fixed-date posts are placed first, for the whole period,** so the slots filled after them can see them coming, and **no release is named twice within 3 days** for any reason. Without that, the catalogue would happily post a release on Friday that Bandcamp Friday names the next week.

Some days have nothing that qualifies, such as a one-release catalogue whose only release is still inside its spacing. On those days **the slot is left empty rather than filled with a repeat.** A week with fewer posts is better than an obvious rerun.

**Only releases catalogued after it was switched on count as release moments.** The back catalogue enters only through rotation, at the artist's chosen rhythm, so turning it on never floods a feed.

## Release campaigns

**A short, more intense run of posts for one new or upcoming release, written by the artist** (Brandon, 2026-10-29). Autopost's rhythm is right for the long tail and too quiet for a launch. A launch is also when artists most want to speak in their own words, so campaigns are manual: Unstream lays out the plan, and the artist writes the posts.

**What Unstream adds, compared with writing them straight into Buffer.** If a campaign were only a compose box, Buffer already has one. Unstream adds three things:

- **A timeline built from the release date.** Choosing a release lays out suggested posts relative to its date: announce (about three weeks before), pre-order open, a week to go, release day, the first Bandcamp Friday after it, and a week on. Each step can be dropped, moved or added to. If the release date changes, every post not yet in Buffer moves with it.
- **The facts, ready to use.** The same `{variables}` as templates (`{link}`, `{where}`, `{price}`, `{date}`), so the pre-order link and the "out on Bandcamp and Mirlo" line are right without copying them in.
- **A prompt for each step,** saying what that post is for ("Tell people the date and where to pre-order"). It's a nudge, not suggested copy.

**How it behaves:**

- **Starting one:** the Promote page offers "Start a campaign" for any release that's `announced` or out within the last 14 days. When Unstream first catalogues such a release for an artist with autopost on, the page shows a banner and sends **one** email offering a campaign. That email is an offer, not an approval: ignoring it changes nothing, and the automatic release moments still run. An artist can turn the email off.
- **Posts are the artist's text,** with an image per post: the cover art, the artist's photo, one of their uploads, or a new upload. Uploads matter most here: a launch is when artists have new photos, a poster or a teaser they want to use, so the campaign editor puts the upload button on each step. Instagram's image rule applies as in autopost, except that a campaign post with no image is flagged when it's written, not skipped silently.
- **It runs on top of the rhythm.** Campaign posts don't count against the weekly number, which is how a release week gets more posts. Autopost steps aside for that release and on campaign days (see "Filling each slot").
- **The same pipeline posts it.** Campaign posts are rows in the same posts table, pushed to Buffer 72 hours ahead with the same rechecks and the tag `unstream: release campaign`. No second scheduler.
- **No approvals here either.** The artist wrote every word, and scheduling a campaign is the consent.

**Out of scope for the first version:** campaigns for anything but a release (tours, merch), and suggested copy of any kind.

## The words: templates, and deciding how they work

**Templates are what the artist edits; the rules above decide which one runs.** Each kind of post (Bandcamp Friday, release day, pre-order, out now, still new, catalogue, support) has a short list of variants, used in turn and never the same variant twice in a row for the same kind.

The template language is deliberately small:

- **`{variables}`** are facts Unstream holds: `{title}`, `{type}` ("album", "EP", "single"), `{date}`, `{year}`, `{age}` ("five years ago"), `{where}` ("Bandcamp and Mirlo", artist-paying first, `orderedSourcePlatforms`), `{price}` (`leadingOfferSummary`), `{link}`, `{name}` (the artist's name).
- **`[optional segments]`** disappear when a variable inside them has no value. `{title}[, from {year}]` doesn't print ", from " for an undated release.
- **`{note}`** is a line the artist writes about a release: where it was recorded, what it's about. It's optional and per release, entered on Manage Releases. It is the cheapest real source of variety, and the only one that sounds like them, so the setup screen asks for it, though only for their three newest releases.

**What artists start from is still open, and Brandon tests it before deciding (Build plan step 2).** There are three options, and the template system supports all of them, so the choice is about defaults, not code:

1. **Unstream's defaults, editable.** Two or three hand-written variants per kind, **in the artist's own voice, first person** ("{title}, my new {type}, is out today!"), since the posts go out from their account (Brandon, 2026-10-29). Least effort. The risk is that every artist using it sounds alike.
2. **Their own, from blank.** The artist writes one line per kind. It's entirely their voice, but it takes more effort and some will never finish setup.
3. **Rules and fields.** The artist fills a few fields once (how they refer to themselves, a sign-off, a `{note}` per release), and fixed sentence patterns assemble them. It's deterministic and personal, but the patterns are the hardest thing here to write well.

My recommendation is option 1, with the `{note}` prompt doing the work of making it personal. That's why it's a test, not a decision.

**American English, avoiding words spelled differently by region** (Brandon, 2026-10-29): "From the archives", not "From the catalogue". Dates read "September 3, 2026".

**Hashtags:** none in the defaults, at most three if the artist adds them, and never `#newmusic` or `#newrelease`: the same rules as Unstream's own posts. **Lengths** (Bluesky 300 characters, Threads and Mastodon 500) are checked when a template is saved, against the longest title in their catalogue, not discovered at send time.

## Pictures, and Instagram

**Images come first from what Unstream already holds, so most artists never upload anything** (Brandon, 2026-10-29). Unstream draws nothing. There are three sources, used in this order:

1. **Release covers.** Every catalogued release already carries `releases.artwork_url`, from its Bandcamp, Mirlo, Faircamp or Discogs listing. Covers are square, so every network takes them.
2. **The artist's photo:** their own `custom_image_url` if they set one on their claimed profile, else `artists.image_url` from their Bandcamp page. That address is already repaired when Bandcamp deletes the old file (`refreshDeadArtistPhoto`). Photos come in any shape, so one outside Instagram's 4:5 to 1.91:1 range is skipped for Instagram.
3. **Photos the artist uploads.** Optional for autopost, there for variety. Campaigns are where they'll really be used (see "Release campaigns").

**Deliberately not sources:**
- **Wikimedia Commons photos,** which MusicBrainz reaches through Wikidata. They usually need a photographer credit to be used, they're mostly of well-known artists, and they can picture a namesake.
- **YouTube channel avatars.** They're small, they'd need a YouTube API key, and the Bandcamp photo is already there.

At one to three posts a week, a handful of covers plus one photo is enough. An artist with four releases and a photo, posting weekly, shows each image about every five weeks.

**Instagram needs an image on every post.** Ticking an Instagram channel during setup says so, shows the images Unstream already has for them, and offers uploads, without requiring them. Then:

- Release-moment and Bandcamp Friday posts use the cover art.
- Catalogue posts on Instagram rotate through their release's cover, the artist's photo and any uploads; support posts through the photo and uploads only, since covers belong to their releases' own posts. Neither repeats an image used on Instagram in the last 4 weeks, so the grid doesn't fill up with one picture.
- **With nothing usable, that Instagram post is skipped** and the other channels go out as normal. The settings page says so: "3 Instagram posts skipped this month: add a photo."

The other networks show a link preview when there's no image, so they're never skipped.

**Uploads, kept small.** Offered in v1 for autopost and needed by campaigns:
- Up to 12 images per artist profile, JPEG or PNG, shared between autopost and campaigns.
- Resized in the browser to 2,048px on the long side before upload, which keeps every request under a Netlify function's 6 MB body limit.
- Rejected with a plain message if they're outside Instagram's shape range. Instagram would refuse them anyway, and cropping someone's photo automatically can cut through a face.
- Stored in R2 (below), and deletable from the settings page.

**Every image is copied to R2 when its post is pushed, and Buffer gets the copy** (settled 2026-10-29). Buffer fetches an image on the day the post publishes, not when it's created: the weekly social posts found that out when a deleted artist photo failed a post (CLAUDE.md, "Social posts"). Bandcamp deletes old files, so the source address can't be trusted to still be there three days later. The copy is keyed by the image's hash, so a cover posted every month is stored once, and it's fetched back from the bucket's public address before Buffer gets it. A source that won't load (a 404) means the post goes without it, and Instagram skips it.

### Storage: R2 for uploads, Buffer's media library later

**R2 holds the copied covers and photos, and what artists upload.** It's in the bucket the social cards already use. It has no egress fees, which matters most here because Buffer and the networks fetch every image, and it's already set up with credentials, the upload helper and the fetch-back check.

**What it costs: in practice, nothing for a long time.** Cloudflare's published R2 prices for Standard storage (recheck before launch):

| | Free each month | Then |
|---|---|---|
| Storage | 10 GB | $0.015 per GB-month |
| Writes (Class A) | 1 million | $4.50 per million |
| Reads (Class B) | 10 million | $0.36 per million |
| Egress | always free | — |

Estimates:

- **Storage.** A 2,048px JPEG is roughly 0.5 MB, so a full 12 uploads plus copied covers come to about 10 MB per artist at most. Most autopost artists will upload nothing, and campaign uploads will be a few images per release, so real use should be far below that. Even at the maximum, 100 artists is about 1 GB and 1,000 is about 10 GB, roughly where the free storage ends.
- **Writes.** Images are keyed by their hash, so each one is stored once however often it's posted. Writes and reads are thousands a month, far inside the free tier.

**At the maximum, the first real bill comes at about 1,000 active artists, and it's under $1 a month for every 10 GB after that.** That's the arithmetic; the risks are elsewhere:

- **Public, unguessable URLs.** The bucket is public, so an uploaded photo can be fetched by anyone who has its URL, including before it's ever posted. The keys are content hashes, impossible to guess, and the photos exist to be posted publicly, so that's acceptable. It's still said here so nobody is surprised.
- **Deleting has to be real.** Removing a photo, switching autopost off for good, or deleting the account deletes the R2 objects, not just the database rows. An image for a post that's already in Buffer stays until that post has gone out.
- **Check the bucket's public address before launch.** Cloudflare rate-limits `r2.dev` addresses and doesn't support them for production. If `SOCIAL_CARDS_PUBLIC_BASE_URL` is an `r2.dev` address, give the bucket a custom domain first.

**Later: Buffer's media library** (Brandon, 2026-10-29). Buffer is building one, with uploads through the API. Once it's available, uploads move there:

- the artist's photos then live in their own Buffer, where they can see and reuse them;
- Unstream stops holding files for them at all, which leaves less to secure and delete.

To make that a one-file change, **all media goes through one small module**, `autopost-media.ts`, with three functions: store, public URL and delete. Nothing else in the feature talks to R2 directly.

## Links

**Every post links to an Unstream page** (Brandon, 2026-10-29): a release post to its release page, `unstream.stream/a/{artist}/{release}`, which lists every place to buy it with what the artist keeps at each, artist-paying first. That is the reason to post through Unstream rather than paste a Bandcamp link, and it's the same page for every network, campaign and artist.

- **Instagram:** no clickable links, so `{link}` becomes "link in bio".
- **No tracking parameters.** The release page is cached at the edge by URL (`cache = "manual"`), and a `?ref=` would split that cache.
- **Clicks aren't counted,** a known limitation for now. No network reports link clicks to Buffer, and the release page loads no script. `release-autopost-analytics-spec.md` lists what counting them would take.

## Networks

**Instagram, Facebook, Threads, Bluesky, Mastodon, LinkedIn and Substack** (Notes), which all take text and an image through Buffer with no further setup. LinkedIn and Substack joined on 2026-10-29 (Brandon). The list and each network's length limit live in `api/shared/autopost-networks.ts`, from Buffer's developer guide.

**Which networks is Unstream's choice, not Buffer's.** Buffer can post to all of them. Left out:

- **YouTube and TikTok** need a video, and autopost has covers and photos.
- **Pinterest** needs a board chosen for each pin. It suits covers and release links well, so it's the likeliest next addition, with a board picker in setup.
- **Start Page and Google Business**: little reason for an artist to post releases there.

The Promote page lists the networks it leaves out in one muted line ("Not available for autopost: …") rather than as disabled checkboxes, so it doesn't read as a Buffer limitation.

Buffer's free plan allows **3 channels and 10 scheduled posts per channel**. Posts go to Buffer only a few days ahead, which stays well inside that at any rhythm.

## The artist stays in charge

**Autopost means no approvals** (Brandon, 2026-10-29). Switching it on is the consent; asking again for every post would undo the reason to use it. Control comes from four places instead:

- **"Coming up"** on the settings page shows the next few weeks exactly as they'll post. The rules are deterministic, so this is the real schedule, not a guess.
- **Buffer.** Each post arrives there about three days before it goes out, where the artist can edit, move or delete it like any other post. **Once a post is in their Buffer, Unstream never edits or deletes it.** Overriding an artist's own edit would be worse than a post they didn't want.
- **Switches** for each kind of post (no support posts, no Bandcamp Friday) and for the whole thing. Off cancels everything not yet in Buffer and leaves what's there alone.
- **Hiding a release** on Manage Releases takes it out of the rotation.

Autopost itself only emails about failures: "Buffer disconnected; reconnect to keep posting." The one other email is the campaign offer for a new release, which can be turned off.

## Which releases qualify

A post asserts, in the artist's own name, that they made a record, so the bar is higher than for showing it on their page:

- **Not `is_hidden`, not `needs_review`.** A release waiting in the dedup review queue is exactly the one that might not be theirs.
- **Sold on a platform from their own links:** a Bandcamp, Mirlo, Faircamp or Jam.coop source. A Discogs-only release (a pressing someone listed) never qualifies.
- **Rechecked at push time,** not just when planned. A release hidden or merged away in between gives up its slot, and that post never reaches Buffer.

The same count of qualifying releases drives the recommended rhythm.

## Catching releases in time

Verified artists are refreshed by the sweep on a 7-day cooldown (`RECATALOG_COOLDOWN_HOURS`), so a release with no pre-order can go up to a week before Unstream sees it. That's why the "out now" post exists. With releases no longer the centre of this, that lag matters less. Two ways to shorten it, for Brandon to decide after the test:

1. **A 2-day cooldown for artists with autopost on.** It's a bounded number of extra catalogue passes, but it is more catalogue writes, and disk I/O has been the expensive resource before.
2. **The artist's own button.** Manage Releases already runs a catalogue pass on request. The settings page can say "Just released something? Check now."

## How it runs

**One scheduled function, `release-autopost-sweep`,** run every 6 hours by a GitHub Action carrying `INTERNAL_FUNCTION_SECRET`, like `recatalog-sweep`. Each run is idempotent:

1. **Plan.** For each artist with it on, whose owner still holds the verified claim and passes the feature gate, plan the next 28 days (`PLAN_HORIZON_DAYS`, the same window "Coming up" shows) from the current catalogue, settings and history. **Upcoming posts aren't stored**: the planner is deterministic, so they're recomputed each time, and a changed catalogue, setting or template simply changes the next plan. Nothing needs re-planning or tidying.
2. **Push.** For every slot due in the next 72 hours: **claim it first** (a row with status `pushing`, unique on `(artist_id, slot_at)`, so a second run finds it taken), copy the image to R2, render the caption for each channel, and create one scheduled Buffer post per ticked channel, tagged `unstream: release autopost`. Then mark it `pushed` with the Buffer post ids, or `failed`.

The release is read fresh on every run, so one hidden, merged or sent to review since it was planned simply isn't in the next plan. A run that dies between the claim and Buffer leaves the slot claimed: a missed post rather than a doubled one.

**Why 72 hours ahead:** it stays far inside the free plan's queue limit, a change in the meantime is caught before posting, and the artist still sees each post in Buffer before it goes.

**Failures:** a dead Buffer grant (`BufferNotConnectedError`) pauses that artist (`paused_reason`); the reconnect email comes before the feature opens to other artists. A slot no channel accepted is `failed` and retried by later runs, three attempts at most. A slot that reached some channels but not others is `pushed`, with the refusals in `error`, and isn't retried, since that would post again to the channels that took it. Everything that didn't go reaches Sentry. No Redis anywhere.

**Time:** an ordinary function has about ten seconds, so a run starts no new artist after five. Artists not reached wait six hours for the next run, well inside the 72 hours.

### The rotation is pure code

The slot filler is a pure function: `planSlots(settings, releases, history, templates, from, to) → slots`. It takes everything as arguments and reads no clock, database or randomness; ties are broken by release id. It lives in its own file with its own tests, which pin every rule above: priority order, spacing, empty slots instead of repeats, the support-post cap, Instagram image choice. The template filler (`renderTemplate`) is the same. Determinism is what makes "Coming up" honest, so tests fail if either function reaches for `Date.now()` or `Math.random()`.

### Tables

All are server-only: RLS on, no policies, read and written by the functions after an ownership check (the claim's `user_id`), with a comment saying the missing policies are deliberate.

Built in `20261029120000_release-autopost.sql`:

- **`release_autopost_settings`**, one row per artist profile: `artist_id` (PK), `user_id`, `enabled`, `enabled_at`, `posts_per_week` (null = recommended), `timezone`, `post_time`, `organization_id`, `channel_ids text[]`, `kinds_off text[]`, `templates jsonb`, `paused_reason`.
- **`release_autopost_posts`**, one row per slot handed to Buffer (upcoming slots aren't stored): `id`, `artist_id`, `slot_at`, `slot_date`, `kind`, `release_id` (null for support posts), `template_index`, `image_key`, `image_on_instagram`, `status` (`pushing` | `pushed` | `failed`), `attempts`, `buffer_post_ids jsonb` (which analytics uses to tell which release a Buffer post was about), `captions jsonb` (exactly what was sent, per channel), `error`, timestamps. Unique on `(artist_id, slot_at)`: that's the claim. Pushing and pushed rows are the history spacing is measured from.
- **`releases.note`**: a new nullable column (280 characters at most) for the per-release `{note}`, added to `curated_fields` when an artist writes it, so a re-crawl never touches it.

Still to come, with campaigns and uploads:

- **Campaign posts** in the same `release_autopost_posts` table, adding `text` (the artist's own words) and `campaign_id`. They're created by the artist ahead of time, so unlike autopost slots they are stored before they're pushed.
- **`release_autopost_campaigns`**: `id`, `artist_id`, `release_id`, `status` (`active` | `ended` | `cancelled`), `created_at`. A campaign's steps are its posts' rows. Each row's position relative to the release date is stored too, so a moved date can move the posts not yet pushed.
- **`release_autopost_images`**: `id`, `artist_id`, `r2_key`, `width`, `height`, `last_used_at`, `created_at`.
- **`release_autopost_settings.campaign_emails`** (default on): the one offer email per new release.

## Reused from curator posts

Already built and merged (#697–#708):

- **Buffer OAuth with PKCE**, the token store and the refresh compare-and-set (`buffer-oauth.ts`, `buffer-db.ts`). The connection is per *user*, so connecting once covers every artist profile they manage.
- **Choosing the organization, never guessing it,** and listing its live channels (`me-buffer.ts`, `buffer-client.ts`).
- **`createPost`, `ensureTag`,** and the R2 bucket and its upload helper.

**What changes:** the OAuth scopes gain Buffer's post-reading scope (presumably `posts:read`; check the name), so analytics can read metrics later without every artist reconnecting. The organization and ticked channels move from the user's `buffer_connections` row to each artist's `release_autopost_settings`, since two bands under one login post to different places. `me-buffer`'s callback always returns to `/curator/new`; it needs a return path held with the OAuth state (same-origin paths only) so the settings page can start the flow too.

## UI: the Promote page

**Its own page, `/promote/:slug`, reached from a Promote button on each artist's card on `/my-artists`, beside Edit and View** (Brandon, 2026-10-29). It began as a tab under Edit, but it isn't about the artist's profile. Shown only to the admin while the flag is off. Built in step 2b (`ArtistPromotePage.tsx`, behind `/api/artist-promote`). Setup is one page, top to bottom:

1. **Where it posts:** connect Buffer, choose the organization (already chosen when there's only one), tick channels. Ticking Instagram explains its image rule.
   - **New to Buffer:** before connecting, the page says an account can be made on Buffer's own screen, and that social accounts have to be connected in Buffer.
   - **No accounts to post to:** signing up through Buffer's screen makes an account with no social accounts connected. When Buffer has none (or none autopost writes for), the page says so and links to [Buffer's channel settings](https://publish.buffer.com/settings/channels), with a "Check again" button.
2. **How often:** a slider from 1 to 7 a week, starting on the recommendation and marked as recommended there. Landing back on it stores "Recommended", which grows with the catalog. **Posting time:** "Recommended: your Buffer queue" (the default) or a set time.
3. **What to say:** each kind with a switch, and its wording folded away until opened: editable variants, each with a live preview against the newest release, and mistakes flagged as they're typed.
4. **Coming up:** the next four weeks, exactly as they'll post: date, kind, release, image, and whether Instagram skips it.
5. **Sent to Buffer:** the latest posts handed over, with anything a channel refused.

Not yet built: the `{note}` prompt (step 3 below), showing the images Unstream holds when Instagram is ticked, campaigns, and a one-line summary on the `/my-artists` card.

**Campaigns**, when built, add "Start a campaign" for any qualifying new or upcoming release. It opens the timeline: one card per step, each with its date, its prompt, a text box with the `{variables}` and a live preview, the image, and the channels. Steps can be added, dropped or moved.

## Measuring it

- **Does it stay on:** artists who switch it on, and how many still have it on after 4 and 12 weeks.
- **Do the posts survive:** posts pushed compared with posts the artist deleted in Buffer. The `unstream: release autopost` tag makes this a Buffer query.
- **Do they reach anyone:** Buffer's engagement numbers by tag and by kind, which also tells us whether catalogue posts earn their place next to release moments. (Not release-page views from GoatCounter: the release page loads no script, so GoatCounter never sees it.)
- **Do campaigns get used:** of the new releases offered a campaign, how many got one, and how many of its steps were written. A campaign started and left half-written means the timeline asks for too much.

## Build plan

1. **The rotation, on paper.** `planSlots` (`api/functions/autopost-plan.ts`) and `renderTemplate` (`api/shared/autopost-templates.ts`) with their tests, plus `npm run preview:autopost -- <artist-slug>`, which prints the next 12 weeks from the real catalogue. That shows what Kid Lightbulbs, a one-release artist and a twenty-release artist would get, before anything posts.
2. **Brandon only.** In two parts: **2a, the engine** (the tables, the sweep that plans and pushes, image copies to R2; `api/functions/release-autopost-sweep.ts`), then **2b, the Promote page** (connecting Buffer with `posts:read` and a return path, the settings, "Coming up"). Then on Kid Lightbulbs' channels for a few weeks. **This is also the templates test:** Brandon tries the defaults against writing his own, and that decides what artists start from.
3. **Release campaigns,** alongside step 2 rather than after it, on Kid Lightbulbs' next release. A launch is where artists feel the need most, so the five artists in step 5 should be offered both together.
4. **Uploads,** shared by autopost and campaigns. Campaigns need them from the start; for autopost they're an optional extra.
5. **Five verified artists,** asked personally, with different catalogue sizes. Watch the measures above for a month.
6. **Decide.** Turn the flag on for every verified artist, change it, or stop. The recommendation formula and the 2-day cooldown are settled here, with real numbers.

## Later

- Anniversary posts ("{title} came out five years ago today"), for day-precise dates. `{age}` already supports them in templates.
- Tour dates, once there's a source (`bandsintown-integration-spec.md`).
- A one-off post the artist writes and drops into the rhythm ("we're playing Leeds Saturday"), taking the next slot.
- Posting directly to Bluesky and Mastodon without Buffer, whose APIs need no app review. Only if Buffer turns out to be the barrier.

## Open questions

1. **What do artists start from: defaults, blank, or rules?** Answered by Brandon's test in Build plan step 2.
2. **Support posts start at 3 a week, the top of the recommended range,** so most artists will never get one. Should one or two a week get an occasional one too, say one a month?
3. **A campaign's suggested timeline:** six steps from three weeks out to a week after. Is that the right shape, or too much to ask an artist to write?
4. **Bandcamp Friday copy.** Bandcamp waives its share that day, but payment processing fees still apply. Is "Bandcamp waives its fee today" accurate enough on its own?
