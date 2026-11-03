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
- **Posting time: "Recommended" is the artist's Buffer posting schedule** (Brandon, 2026-10-29), and it's the default ("Pick days & times for me"). Buffer's API has no "recommended time" mode, but a channel's posting schedule is set by default from Buffer's own recommended times, so it is the recommendation. Each channel's post is scheduled (`customScheduled`) at the earliest time in that channel's `postingSchedule` on the planned day, in the channel's timezone (`queueTimeOn`); a channel whose day is paused, empty or already past skips that post, and says why in the slot's `error`. When no channel has a time that day, the slot isn't claimed at all: it's listed as `unscheduled` in the sweep's summary, not failed, retried or sent to Sentry, and its post comes round on a later day. Like a set time, it reaches Buffer **three days ahead**, where the artist can see it. **Not `addToQueue`**, which this first used: the queue fills the next open slot from *now*, so a post handed over early goes out early, and handing it over only on its day (the workaround) meant the artist saw nothing in Buffer until then. That was the first thing Brandon noticed on trying it (2026-10-30).

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
4. **A call for support** replaces a catalogue post at most once every 4 posts. Below 3 posts a week it also waits 28 days since the last one, so it comes about once a month (Brandon, 2026-11-02: until then it never ran below 3 a week, which left the asset library nothing to do at the recommended rhythm). It links to their Tip page if they take tips, otherwise their artist page (`unstream.stream/a/{artist}`). It's the one post not about a release, so it's the one that carries the artist's uploads (see "Pictures").

**A release with a campaign is left to the campaign.** Autopost writes no release-moment or catalogue posts about it while the campaign runs, and leaves any day the campaign posts on empty, **and the day either side of it** (`CAMPAIGN_GAP_DAYS`, Brandon, 2026-11-02), so a launch never stacks an autopost against a campaign post on consecutive days. That way no day gets two posts and nothing is said twice. Releases without a campaign still get the automatic moments above, inside the weekly number.

**Fixed-date posts are placed first, for the whole period,** so the slots filled after them can see them coming, and **no release is named twice within 3 days** for any reason. Without that, the catalogue would happily post a release on Friday that Bandcamp Friday names the next week.

Some days have nothing that qualifies, such as a one-release catalogue whose only release is still inside its spacing. On those days **the slot is left empty rather than filled with a repeat.** A week with fewer posts is better than an obvious rerun.

**Only releases catalogued after it was switched on count as release moments.** The back catalogue enters only through rotation, at the artist's chosen rhythm, so turning it on never floods a feed.

## Release campaigns

**A short, more intense run of posts for one new or upcoming release** (Brandon, 2026-10-29; built 2026-11-02). Autopost's rhythm is right for the long tail and too quiet for a launch. The Campaigns tab of the Promote page (`/promote/:slug/campaigns`, `PromoteCampaignsPage.tsx`).

**How it works:**

1. **Pick a release, confirm its date, choose how early to start** (1 to 8 weeks before; 4 is recommended). Any qualifying release can be picked, since a re-release or a wrongly catalogued date is the artist's call; the date they confirm is the one `{date}` reads.
2. **Unstream proposes the posts** (`proposeCampaign`, `api/functions/campaign-plan.ts`, pure and tested). This changed from the first design, where the artist wrote every post from a blank prompt (Brandon, 2026-11-02): the proposal is a set of **drafts from templates**, in the artist's first-person voice, filled with Unstream's facts. **Still no LLM** (see "No LLM writes the posts"). The artist edits, moves, drops or adds posts before anything is scheduled.
3. **It lays over autopost.** The editor shows the campaign's weeks as a calendar with its posts, autopost's days and release day. Autopost steps aside on each campaign day and the day either side, so no network gets two Unstream posts on one day, and campaign posts don't count against the weekly number.

**The timeline** (`CAMPAIGN_STEPS`, `api/shared/campaign-steps.ts`; D is release day):

| Step | When | Image |
|---|---|---|
| Announcement | the start date | cover |
| The story behind it | D−21 | an upload or their photo |
| Thanking the people on it (album or EP only) | D−14 | an upload or their photo |
| One week to go | D−7 | cover |
| Tomorrow | D−1 | an upload or their photo |
| Release day | D | cover |
| Thank you | D+3 | an upload or their photo |
| In case you missed it | D+10 | cover |
| Bandcamp Friday | the first after release, within 45 days | cover |

Posts are **at least 2 days apart**, except the day before release and release day. When a short runway puts two steps too close, the one that matters more to the launch stays (release day, then the announcement, the week-to-go and Bandcamp Friday, then the rest). Nothing is proposed before tomorrow. Drafts ask for pre-orders only while the release is `announced` and only before release day.

**Where the shape comes from.** Published, unpaywalled release-promotion advice agrees on the order of the beats, though few sources give day offsets and almost none give post counts: CD Baby's six-week social plan (four weeks before, two after) and its 30-day plan (announce about 25 days out), Sonicbids' four-week plan (first track about D−21, pre-order push about D−14), and a daily countdown in the final week, which CD Baby puts in Stories rather than the feed, hence only "a week to go" and "tomorrow" here. Buffer's 2025 frequency studies put Instagram's sweet spot at 3–5 posts a week and LinkedIn's at 2–5, and found the biggest gain going from 1–2 posts to 3–5. A launch week of campaign plus autopost lands there. Buffer's 2026 format data and Rachel Karten's *Link in Bio* both warn against repeating the same post, which is why personal steps rotate through the artist's uploads and photo while release steps use the cover. No unpaywalled musician-specific material from Karten or Matt Navarra was found, so nothing here is attributed to them. Bandcamp's own guidance that pre-orders suit established artists, and that a pre-order is released by hand, is why pre-order wording only appears while the release is announced.

**How it behaves:**

- **Posts are the artist's text,** stored as templates (`release_campaign_posts.text`) and filled when sent, so `{link}` reads "link in bio" on Instagram and TikTok and `{where}` is current. Every post is checked on save: a real date from tomorrow on, one post a day per campaign and none on another campaign's day, valid template, fits every ticked network, and an image the artist still has.
- **Images:** the cover, the artist's photo, any upload, or none. Instagram's rule applies as in autopost, and a post with no image (or an upload outside Instagram's shape) is **flagged in the editor**, not skipped silently.
- **The same pipeline posts it.** `release-autopost-sweep` sends due campaign posts 72 hours ahead with the same rechecks (verified claim, feature gate, ticked channels still in Buffer, the release still qualifying) and the tag `unstream: release campaign`, **whether autopost is switched on or not**; a paused artist's campaign waits with their autopost. Campaign posts go to the channels and posting time chosen on the Autopost tab.
- **Editing:** moving release day moves every post not yet in Buffer by the same number of days. Posts already in Buffer are shown, never changed. Saving replaces the unsent posts in one transaction (`save_release_campaign`).
- **Stopping** deletes the unsent posts; the ones already in Buffer stay there.
- **A post whose day passes unsent** (Buffer down for three days, say) is not sent late.
- **No approvals here either.** The artist pressed Schedule, which is the consent.

**Not built yet:** the email offering a campaign when a new release is catalogued, and campaigns for anything but a release (tours, merch).

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
3. **Photos the artist uploads,** in the **Asset library** tab (`/promote/:slug/assets`, built 2026-11-02). Autopost puts them **only on posts that aren't about a release**, which today means the call for support, in turn, least recently used first (Brandon, 2026-11-02). Campaign posts can use any of them.

**Deliberately not sources:**
- **Wikimedia Commons photos,** which MusicBrainz reaches through Wikidata. They usually need a photographer credit to be used, they're mostly of well-known artists, and they can picture a namesake.
- **YouTube channel avatars.** They're small, they'd need a YouTube API key, and the Bandcamp photo is already there.

At one to three posts a week, a handful of covers plus one photo is enough. An artist with four releases and a photo, posting weekly, shows each image about every five weeks.

**Instagram needs an image on every post.** Ticking an Instagram channel during setup says so, shows the images Unstream already has for them, and offers uploads, without requiring them. Then:

- Release-moment and Bandcamp Friday posts use the cover art.
- Catalogue posts on Instagram use their release's cover, or the artist's photo when Instagram showed that cover recently; support posts rotate through the uploads and the photo, since covers belong to their releases' own posts. Neither repeats an image used on Instagram in the last 4 weeks, so the grid doesn't fill up with one picture.
- **With nothing usable, that Instagram post is skipped** and the other channels go out as normal. The settings page says so: "3 Instagram posts skipped this month: add a photo."

The other networks show a link preview when there's no image, so they're never skipped.

**Uploads, kept small.** Offered in v1 for autopost and needed by campaigns:
- Up to 12 images per artist profile, shared between autopost and campaigns (`promote_assets`).
- Any format the browser can read (JPEG, PNG, WebP, GIF, AVIF), resized in the browser to 2,048px on the long side and re-encoded as JPEG before upload (`promoteImages.ts`). That keeps every request under a Netlify function's 6 MB body limit and strips location metadata. The server reads the bytes' own header and stores only JPEG or PNG.
- **Accepted whatever their shape** (changed 2026-11-02 from rejecting them): one outside Instagram's range is marked "Not for Instagram" and goes to the other networks only, like an artist photo of that shape. Never cropped automatically, which can cut through a face.
- Stored in R2 under `promote/{artistId}/{hash}` (below). **Removing one is real:** it's hidden at once, and the file is deleted as soon as no post already in Buffer needs it, straight away or by a later sweep (`purgeRemovedAssets`). Unsent campaign posts using it lose their image and are flagged.

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

**Instagram, TikTok, Facebook, Threads, Bluesky, Mastodon, LinkedIn and Substack** (Notes), which all take text and an image through Buffer with no further setup. LinkedIn, Substack and TikTok joined on 2026-10-29 (Brandon). **Instagram and TikTok are image-first** (`IMAGE_FIRST_NETWORKS`): every post needs an image, no image repeats there within four weeks, and with no clickable links in captions `{link}` reads "link in bio". Only Instagram's 4:5 to 1.91:1 shape range is enforced; TikTok photo posts take images as they are (check this against the first real TikTok post). The list and each network's length limit live in `api/shared/autopost-networks.ts`, from Buffer's developer guide.

**Which networks is Unstream's choice, not Buffer's.** Buffer can post to all of them. Left out:

- **YouTube** needs a video, and autopost has covers and photos. (TikTok takes photo posts, so it's in.)
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

**Failures:** a dead Buffer grant (`BufferNotConnectedError`) pauses that artist (`paused_reason`), and the sweep's summary says why the grant was unusable. Reconnecting Buffer lifts that pause by itself (`resumeAfterReconnect`, in the OAuth callback), but only for artists set up in an organization the reconnected account belongs to; reconnecting a different Buffer login leaves them paused until the artist picks channels and saves, and the Promote page says so; the reconnect email comes before the feature opens to other artists. A slot no channel accepted is `failed` and retried by later runs, three attempts at most. A slot that reached some channels but not others is `pushed`, with the refusals in `error`, and isn't retried, since that would post again to the channels that took it. Everything that didn't go reaches Sentry. No Redis anywhere.

**Time:** an ordinary function has about ten seconds, so a run starts no new artist after five. Artists not reached wait six hours for the next run, well inside the 72 hours.

### The rotation is pure code

The slot filler is a pure function: `planSlots(settings, releases, history, templates, from, to) → slots`. It takes everything as arguments and reads no clock, database or randomness; ties are broken by release id. It lives in its own file with its own tests, which pin every rule above: priority order, spacing, empty slots instead of repeats, the support-post cap, Instagram image choice. The template filler (`renderTemplate`) is the same. Determinism is what makes "Coming up" honest, so tests fail if either function reaches for `Date.now()` or `Math.random()`.

### Tables

All are server-only: RLS on, no policies, read and written by the functions after an ownership check (the claim's `user_id`), with a comment saying the missing policies are deliberate.

Built in `20261029120000_release-autopost.sql`:

- **`release_autopost_settings`**, one row per artist profile: `artist_id` (PK), `user_id`, `enabled`, `enabled_at`, `posts_per_week` (null = recommended), `timezone`, `post_time`, `organization_id`, `channel_ids text[]`, `kinds_off text[]`, `templates jsonb`, `paused_reason`.
- **`release_autopost_posts`**, one row per slot handed to Buffer (upcoming slots aren't stored): `id`, `artist_id`, `slot_at`, `slot_date`, `kind`, `release_id` (null for support posts), `template_index`, `image_key`, `image_on_instagram`, `status` (`pushing` | `pushed` | `failed`), `attempts`, `buffer_post_ids jsonb` (which analytics uses to tell which release a Buffer post was about), `captions jsonb` (exactly what was sent, per channel), `error`, timestamps. Unique on `(artist_id, slot_at)`: that's the claim. Pushing and pushed rows are the history spacing is measured from.
- **`releases.note`**: a new nullable column (280 characters at most) for the per-release `{note}`, added to `curated_fields` when an artist writes it, so a re-crawl never touches it.

Built in `20261102120000_promote-assets-and-campaigns.sql`:

- **`promote_assets`**: `id`, `artist_id`, `user_id`, `storage_key`, `url`, `content_type`, `width`, `height`, `byte_size`, `deleted_at`, `created_at`. Named for the Promote page rather than autopost, since campaigns share it and it may hold other media later.
- **`release_campaigns`**: `id`, `artist_id`, `user_id`, `release_id`, `release_date` (the date the artist confirmed), `status` (`active` | `cancelled`). One running campaign per release.
- **`release_campaign_posts`**: `campaign_id`, `step`, `post_date`, `text`, `image_key`, then the same push columns as autopost's (`status` adds `planned`, `attempts`, `slot_at`, `buffer_post_ids`, `captions`, `error`). Unique on `(campaign_id, post_date)`. **A table of its own rather than rows in `release_autopost_posts`** as first planned: campaign posts are stored and edited ahead, autopost rows exist only once claimed, and sharing one table would have put a filter on every autopost read and a second meaning on its `(artist_id, slot_at)` claim.
- **`save_release_campaign()`**: replaces a campaign's unsent posts in one transaction. EXECUTE revoked from `PUBLIC, anon, authenticated`.

Still to come: **`release_autopost_settings.campaign_emails`** (default on), the one offer email per new release.

## Reused from curator posts

Already built and merged (#697–#708):

- **Buffer OAuth with PKCE**, the token store and the refresh compare-and-set (`buffer-oauth.ts`, `buffer-db.ts`). The connection is per *user*, so connecting once covers every artist profile they manage.
- **Choosing the organization, never guessing it,** and listing its live channels (`me-buffer.ts`, `buffer-client.ts`).
- **`createPost`, `ensureTag`,** and the R2 bucket and its upload helper.

**What changes:** the OAuth scopes gain Buffer's post-reading scope (presumably `posts:read`; check the name), so analytics can read metrics later without every artist reconnecting. The organization and ticked channels move from the user's `buffer_connections` row to each artist's `release_autopost_settings`, since two bands under one login post to different places. `me-buffer`'s callback always returns to `/curator/new`; it needs a return path held with the OAuth state (same-origin paths only) so the settings page can start the flow too.

## UI: the Promote page

**Its own page, `/promote/:slug`, reached from a Promote button on each artist's card on `/my-artists`, beside Edit and View** (Brandon, 2026-10-29). It began as a tab under Edit, but it isn't about the artist's profile. **Tabs along its top, one per promotion tool** (Brandon, 2026-10-30; `PromoteTabs.tsx`): Autopost is at `/promote/:slug` itself; Campaigns and the Asset library are at paths below it, and on-demand social cards and the embeddable widget are expected to join them the same way. Shown only to the admin while the flag is off. Built in step 2b (`ArtistPromotePage.tsx`, behind `/api/artist-promote`). Setup is one page, top to bottom:

1. **Where it posts:** connect Buffer, choose the organization (already chosen when there's only one), tick channels. (Ticking Instagram used to explain its image rule; that went with the copy trim of 2026-10-30, since a post that skips it says so in "Coming up".) **The on/off switch sits at the top of this section** (Brandon, 2026-10-29), shown once Buffer has a channel autopost can use. It saves the moment it's flipped and says in words what each position means: on, posts go to Buffer; off, nothing more does, **nothing is saved as a draft**, and the settings are kept.
   - **New to Buffer:** before connecting, the page says an account can be made on Buffer's own screen, and that social accounts have to be connected in Buffer.
   - **No accounts to post to:** signing up through Buffer's screen makes an account with no social accounts connected. When Buffer has none (or none autopost writes for), the page says so and links to [Buffer's channel settings](https://publish.buffer.com/settings/channels), with a "Check again" button.
**Everything below is hidden until Buffer is connected with a channel autopost can use** (Brandon, 2026-10-29): without somewhere to post it does nothing. A short note says what comes next instead. The trade: an artist can't preview their posts before connecting.

2. **How often:** a slider from 1 to 7 a week, starting on the recommendation and marked as recommended there. Landing back on it stores "Recommended", which grows with the catalog. **Posting time:** "Pick days & times for me", which is Buffer's queue (the default), or a set time.
3. **What to say:** each kind with a switch, and its wording folded away until opened: editable variants, each with a live preview against the newest release, and mistakes flagged as they're typed.
4. **Coming up:** today and the next four weeks, exactly as they'll post: date, kind, release, image, and whether Instagram skips it. **A week at a time** (Brandon, 2026-10-30): four tabs from the artist's today, each with its post count and a dot when something in it needs a look, then that week's seven days as a strip and its posts underneath. Each post's state is a row of small chips, an icon and a word or two each, with the reason as the tooltip: when it goes to Buffer, "Retrying", "Failed", or once it's in Buffer one chip per channel (its scheduled time, "Posted" linking to the post, "Failed", "Draft", "Needs approval", "Removed", "Skipped"). Each channel's state is read back from Buffer by channel and creation date, matched on the post ids stored at push. Built by `autopost-schedule-view.ts`; while the page is in view it reads `?part=schedule` again every two minutes and on returning to the tab.
5. **Recent:** the last two weeks of posts, newest first, with the same status.

Campaign posts appear in "Coming up" and "Recent" beside autopost's, labelled "Campaign: {step}".

**Tabs** (2026-11-02): Autopost, **Campaigns** (`/promote/:slug/campaigns`; see "Release campaigns") and **Asset library** (`/promote/:slug/assets`; see "Pictures"). Each keeps to the Autopost tab's amount of copy: one line saying what it's for, then the tool.

Not yet built: the `{note}` prompt (step 3 below), showing the images Unstream holds when Instagram is ticked, and a one-line summary on the `/my-artists` card.

## Measuring it

- **Does it stay on:** artists who switch it on, and how many still have it on after 4 and 12 weeks.
- **Do the posts survive:** posts pushed compared with posts the artist deleted in Buffer. The `unstream: release autopost` tag makes this a Buffer query.
- **Do they reach anyone:** Buffer's engagement numbers by tag and by kind, which also tells us whether catalogue posts earn their place next to release moments. (Not release-page views from GoatCounter: the release page loads no script, so GoatCounter never sees it.)
- **Do campaigns get used:** of the new releases offered a campaign, how many got one, and how many of its steps were written. A campaign started and left half-written means the timeline asks for too much.

## Build plan

1. **The rotation, on paper.** `planSlots` (`api/functions/autopost-plan.ts`) and `renderTemplate` (`api/shared/autopost-templates.ts`) with their tests, plus `npm run preview:autopost -- <artist-slug>`, which prints the next 12 weeks from the real catalogue. That shows what Kid Lightbulbs, a one-release artist and a twenty-release artist would get, before anything posts.
2. **Brandon only.** In two parts: **2a, the engine** (the tables, the sweep that plans and pushes, image copies to R2; `api/functions/release-autopost-sweep.ts`), then **2b, the Promote page** (connecting Buffer with `posts:read` and a return path, the settings, "Coming up"). Then on Kid Lightbulbs' channels for a few weeks. **This is also the templates test:** Brandon tries the defaults against writing his own, and that decides what artists start from.
3. **Release campaigns,** alongside step 2 rather than after it, on Kid Lightbulbs' next release. A launch is where artists feel the need most, so the five artists in step 5 should be offered both together. **Built 2026-11-02**, except the offer email.
4. **Uploads,** shared by autopost and campaigns: the Asset library tab. **Built 2026-11-02.**
5. **Five verified artists,** asked personally, with different catalogue sizes. Watch the measures above for a month.
6. **Decide.** Turn the flag on for every verified artist, change it, or stop. The recommendation formula and the 2-day cooldown are settled here, with real numbers.

## Later

- Anniversary posts ("{title} came out five years ago today"), for day-precise dates. `{age}` already supports them in templates.
- Tour dates, once there's a source (`bandsintown-integration-spec.md`).
- A one-off post the artist writes and drops into the rhythm ("we're playing Leeds Saturday"), taking the next slot.
- Posting directly to Bluesky and Mastodon without Buffer, whose APIs need no app review. Only if Buffer turns out to be the barrier.

## Open questions

1. **What do artists start from: defaults, blank, or rules?** Answered by Brandon's test in Build plan step 2.
2. ~~Support posts below 3 a week?~~ Settled 2026-11-02: about once a month (28 days apart), so uploads appear at every rhythm.
3. **A campaign's suggested timeline:** up to nine posts over a four-week runway, now proposed as drafts rather than blank prompts. Is that too many for a small artist's audience? Watch how many proposed posts artists delete before scheduling.
4. **Bandcamp Friday copy.** Bandcamp waives its share that day, but payment processing fees still apply. Is "Bandcamp waives its fee today" accurate enough on its own?
