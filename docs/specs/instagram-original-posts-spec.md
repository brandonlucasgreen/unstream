# Instagram: original posts, or none

**Status:** built 2026-10-01. The cards are drawn by `api/functions/social-card.ts` (a Netlify Function, not an edge function: see "Instagram cards" in `docs/engineering-history.md` for the CPU measurement). The carousel is added to the indie spotlight in `scripts/generate-social-posts.ts`, and goes to Buffer as drafts until `INSTAGRAM_DRAFTS_BEFORE`. Step 4, watching Account Status for 30 days, is still to do.

## Why Instagram is paused

From 22 March to 30 September 2026 the pipeline sent 177 Instagram posts: one artist press photo a day with a caption. Their median reach was **3 accounts**, and they brought in **2 follows** in total. Both follows, and the only posts that reached more than ~10 accounts, were tagged indie artists who presumably reshared the post themselves. The 81 comments were almost all bots: 58 of the 66 from July to September landed on posts tagged `#newmusic #newrelease`.

The likely cause is Instagram's 30 April 2026 change. Accounts that mostly post other people's photos are no longer eligible for recommendations (Explore, Reels, suggested posts). Followers still see the posts, but nobody else does. Instagram judges this over a rolling 30-day window. A daily press photo is exactly the content that rule targets, so no change to the captions fixes it. You can check the current state under Settings → Account Status → recommendation eligibility.

## What would make it worth restarting

**Images Unstream made itself.** Instagram counts content as original when it is "materially edited with unique text, graphics, commentary" or designed by the account. It does not count credits or watermarks. One designed card per artist would qualify, built from Unstream's own data:

- **Slide 1:** artist name, where to buy, and the registry payout (e.g. "80-85% to the artist on Bandcamp").
- **Slide 2:** latest release cover art and title.
- **Slide 3:** the purchase math ("a $10 album pays them at least $8, around 2,700 streams' worth").
- **Last slide:** the press photo, credited.

Carousels are also the format Instagram's 2026 data favours. They have the best reach rate and about twice the engagement of single images (Buffer, Socialinsider). Single-image posts lost about 22% of their reach year on year (Metricool).

## What the Buffer API can and can't do (checked 2026-10-01)

| Need | Supported | How |
|---|---|---|
| Carousel | Yes, up to 10 images | several `assets[].image` entries, `metadata.instagram.type: 'post'` |
| Alt text | Yes | `assets[].image.metadata.altText` |
| Tag the artist in the photo | Yes | `assets[].image.metadata.userTags: [{ handle, x, y }]`; on a carousel, the first image's tags apply to every slide |
| Collab invite (Instagram's own suggested remedy) | **No** | No field. It can only be done manually in Instagram |
| Clickable link | No | Captions aren't clickable; use "link in bio" |
| Grouping with the Threads/Bluesky posts | Yes | add the Instagram variant to the day's `createContentItem` call |

Buffer fetches every image at publish time. Images must therefore be at **public, permanent URLs**. Nothing is uploaded.

## The build

1. **Render the cards** in an edge function, e.g. `/social-card/{slug}/{n}.png`, from the same data the artist page uses. Deno can render SVG to PNG with a WASM renderer imported from `esm.sh`; that is a new dependency, so check its size against the edge bundle limit. Rendering on request means there's nothing to store or clean up, and Buffer's fetch is the only caller. *As built: a Netlify Function at `/api/social-card/{slug}/{slide}.png`, because a photo slide needs more than the edge's 50ms of CPU.*
2. **Add the Instagram variant** to the indie spotlight group in `generate-social-posts.ts`:
   - card URLs as the assets;
   - the artist in `userTags` when they have an Instagram link;
   - at most three specific hashtags. Not `#newmusic` or `#newrelease`: they were wrong for 72 of 75 prominent posts, and they attracted the bots.
3. **Indie artists only.** Prominent artists never reshared, and they're the case where a press photo is least defensible.
4. **Watch Account Status for 30 days.** Recommendation eligibility should return once most of the last 30 days' posts are original.

## Open questions

- ~~Should the card carry the artist's own claimed image when they set one (`custom_image_url`)?~~ Yes, as built: the photo slide uses the artist page's own choice, which is the claimed image when there is one.
- Press photos are usually the photographer's copyright. **Still open.** As built, the photo is the last slide, fitted rather than cropped, and credited to where it came from ("Photo from their Bandcamp page"), the same image the Threads and Bluesky posts already attach. It isn't credited to a photographer, because Unstream doesn't know who took it. Dropping the slide is a one-line change in `cardSlides`.
