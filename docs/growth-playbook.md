# Growth Playbook

Strategy and operational plans for growing Unstream. Covers channels, sequencing, and execution playbooks.

---

## Content pillars

All content maps to one of these four angles:

1. **Artist Economics** — Hard numbers about streaming payouts, platform comparisons, artist success stories
2. **Platform Discovery** — Guides to platforms most fans don't know about (Mirlo, Ampwall, Faircamp, library services)
3. **How-To for Fans** — Practical: "How to support your favorite artist for $5", "3 ways to listen to music for free through your library"
4. **Builder/Open Source** — Dev updates, architecture decisions, community contributions

---

## Growth channels

### Organic search (SEO)

Unstream has a strong SEO foundation: 104KB sitemap, pre-generated artist pages with structured JSON-LD data. Build on this:

* **Artist comparison pages:** Auto-generate pages like "Where to buy [Artist Name] music besides Spotify" for top-searched artists. High-intent, low-competition queries.
* **Platform comparison content:** Static pages comparing artist payouts across platforms (e.g., "Bandcamp vs Spotify: What Artists Actually Earn").
* **Improve meta descriptions:** Each artist page should have a unique meta: "[Artist] is available on [N] platforms. See where your money goes — Bandcamp pays 82%, Spotify pays 0.3%."

### Community-led growth

**Bandcamp community** — the beachhead audience. These people already believe in direct support.

* Time content around Bandcamp Fridays (see playbook below)
* Reach this audience via Reddit (r/BandCamp) and press coverage, not through Bandcamp-adjacent blogs (they're flooded with artist pitches and unlikely to cover a tool)

**Musician community** — artists are both users and evangelists.

* "Artist Verified" badge program — artists who claim their Unstream profile get a verified badge and share a branded link (unstream.stream/a/[name])
* One-page guide: "How to list your music on platforms that pay more" — practical, shareable, positions Unstream as the authority

**Open source community:**

* Submit to awesome-selfhosted, awesome-music, and similar curated lists
* Technical blog post about the architecture for Hacker News / dev community crossover

### Browser extension as growth engine

The Chrome/Firefox extension meets users where they already are (Spotify Web, YouTube, Apple Music). Highest-leverage growth vector.

* **Chrome Web Store optimization:** Better screenshots showing payout % comparison. Keywords: "artist payout", "support artists", "ethical music", "Bandcamp finder"
* **Extension install CTA on web app:** After a user's 3rd search, subtle prompt: "Love searching? Install the extension to get Unstream results while you stream."
* **Social sharing from results:** Refine share text to emphasize the payout transparency angle.

### Aligned-organization partnerships (primary growth channel)

Press coverage and data pitches are not the path right now. The streaming payout story has been written ad nauseam — Unstream isn't adding new data to that conversation. What Unstream adds is a *product* that shifts fan behavior. The interesting story will be behavioral proof that fans act when given the option, but that requires usage first.

**Focus on organizations that put Unstream in front of fans at the moment they're already thinking about supporting artists:**

* **UMAW (United Musicians and Allied Workers)** — 30K+ members who already believe in streaming reform. They need a concrete tool to point fans to. Unstream is that tool. A UMAW endorsement is a credibility multiplier that makes every other pitch easier.
* **ListenBrainz / MetaBrainz** — ~50K users who chose the open-source path. Natural integration: "Find where to support this artist directly" link on ListenBrainz artist pages. Shared data layer (MusicBrainz), shared values. Start with a post on community.metabrainz.org.
* **Public libraries** — 17K+ US libraries want to promote Hoopla and Freegal but patrons don't know they exist. Unstream already surfaces these. A one-pager to digital services librarians at NYPL, Brooklyn Public Library, LA Public Library could unlock a huge, warm channel.
* **Artist Rights Alliance / Featured Artists Coalition (UK)** — Similar to UMAW. Organizations that need actionable recommendations for fans. "Use Unstream to see where your money goes."
* **EFF / Fight for the Future** — Open-source, no tracking, alternative to Big Tech music platforms. Fits their "alternatives" messaging.

**What NOT to do:** Don't add noise to the small indie platform teams (Mirlo, Ampwall, etc.) — they're stretched thin building their own products. Raise Unstream naturally in conversations with those folks, but focus partnership energy on organizations *outside* Unstream's existing circle to expand it.

### Content partnerships (deferred)

Pitching music journalism directly hasn't worked yet (Hypebot pitch sent 2026-03-20, no response). The "data about streaming payouts" angle is not novel. Defer media outreach until there's a behavioral story to tell — proof that fans are shifting spending through Unstream.

**When to revisit:** Once Unstream has a UMAW endorsement, a ListenBrainz integration, and/or a few hundred weekly active users, the story shifts from "here's a tool" to "here's a grassroots movement" — and that story writes itself.

**Alternative angles for when the time comes:**
* Guest posts on Hypebot/DMN (they accept contributed articles — write about the fan behavior shift, not the tool)
* Music podcasts (Switched on Pop, Trapital, Music Tectonics) — pitch yourself as a guest with a "musician who built a tool" angle
* YouTube creators (Rick Beato, Finn McKenty) — offer payout comparison visuals for their streaming economics videos
* Engage directly with specific reporters on Threads/Bluesky before pitching

---

## Landing page & store listing copy

### Web app

**Current site header (live):**

> Support artists directly on alternative platforms.
> Reduce your dependency on streaming.

**Key principles for any copy changes:**
* "Alternative platforms" and "reduce dependency" are the framing — not "move off streaming" or "quit Spotify"
* Add payout transparency as a visible feature ("Bandcamp: 82% to artist. Spotify: 0.3%.")
* Emphasize free/no-catch positioning early
* Keep the macOS app promo section
* Lean into Robin Hood angle: "Unstream is free because the point is getting money to artists, not charging you to find them."

### Chrome Web Store

* **Short description:** "See where your money actually goes. Unstream shows artist payout percentages and finds them on 13+ platforms — free."
* **Detailed description:** Lead with payout transparency hook. Include "works on Spotify, YouTube, Apple Music." Mention open source and free.
* **Keywords:** artist payout, support artists, ethical music, Bandcamp finder, music discovery, streaming alternative

### Firefox

Mirror Chrome copy, adjust for Firefox audience (more privacy-conscious — emphasize "no tracking, open source").

---

## Reddit engagement

### Target subreddits

| Subreddit | Audience | Angle |
|-----------|----------|-------|
| r/BandCamp | Bandcamp buyers & sellers | Bandcamp Friday content, tool for finding artists across platforms |
| r/WeAreTheMusicMakers | Independent musicians | Artist profiles, payout % data, claiming your page |
| r/indieheads | Indie music fans | "Support artists directly" angle, discovery tool |
| r/audiophile | Audio quality enthusiasts | Qobuz integration, owning music vs. renting |
| r/musichoarder | Digital music collectors | Library building, platform comparison |
| r/selfhosted | Tech-savvy users | Faircamp integration, decentralized music |
| r/flac / r/DigitalAudioPlayer | Lossless audio fans | Buying lossless from Bandcamp/Qobuz via Unstream |

### Content types

1. **Bandcamp Friday posts** — "It's Bandcamp Friday" reminder with Unstream link. Time-sensitive, recurring.
2. **"I built this" posts** — Authentic founder story. Post in r/SideProject, r/WebDev, r/InternetIsBeautiful. *(Defer until after Hypebot pitch outcome — press coverage becomes social proof.)*
3. **Value-add comments** — When someone asks "where can I buy X's music directly?", link Unstream. Genuine helpfulness only.
4. **Payout comparison content** — The FAQ payout data is unique and shareable.
5. **Extension announcements** — Announce Chrome/Firefox extension in relevant subs.

### Rules of engagement

- Never spam. Contribute value first, mention Unstream second.
- Use the founder's authentic voice (musician who built this for themselves)
- Disclose it's your project when posting about it
- Engage with comments genuinely

### Cadence

- **Each Bandcamp Friday**: Post reminder content
- **Monthly**: One substantive post (payout comparison, new feature, founder story)

---

## Bandcamp Friday playbook

Bandcamp Fridays are the strongest time-sensitive marketing hook and the highest-ROI recurring opportunity. Unstream already has a built-in Bandcamp Friday feature (countdown/indicator in web app + browser extension).

**Confirmed dates:** Check https://daily.bandcamp.com/features/bandcamp-fridays for the official list.

**Next up: May 2, 2026**

### T-minus plan (repeat each Bandcamp Friday)

**T-7 days: Prep**
- Draft social posts for Threads, Bluesky, Mastodon, LinkedIn
- Draft Reddit post for r/BandCamp
- Prepare "Bandcamp Friday guide" angle: "Use Unstream to find if your favorite artist is on Bandcamp"

**T-1 day: Pre-event**
- Post "Tomorrow is Bandcamp Friday" teaser on social
- Share payout % comparison (Bandcamp at ~80-85% normally → ~92-95% on BC Friday)

**Day-of:**
- Morning post: "It's Bandcamp Friday! Find your favorite artists on Bandcamp →" with link
- Reddit: Post in r/BandCamp, comment in r/indieheads weekly thread

**T+1 day: Recap**
- If analytics show a traffic spike, share it (GoatCounter is public)
- Thank-you post to community

---

## Press outreach (on hold)

Press outreach is paused until Unstream has a stronger behavioral story to tell. The streaming payout data angle is not novel — every music publication has covered it. What's novel is a product that actually shifts fan behavior, but proving that requires more organic usage first.

### What happened
- Hypebot pitch sent 2026-03-20. No response as of 2026-03-31.
- The pitch angle ("musician built a tool") is fine but lands in the same inbox as hundreds of similar pitches.

### When to resume
Resume press outreach when one or more of:
- UMAW officially recommends Unstream
- ListenBrainz integration ships
- Weekly active users hit 200+ consistently
- A specific behavioral data point emerges ("X% of users who found an artist on Unstream clicked through to buy")

### How to resume (don't repeat the same approach)
1. **Build reporter relationships first.** Engage with streaming economics coverage on Threads/Bluesky. Be a familiar name before pitching.
2. **Guest post, don't pitch.** Hypebot and DMN accept contributed articles. Write about the fan behavior shift, mention Unstream naturally.
3. **Target specific reporters, not inboxes.** Find the individual journalist who covers this beat at each publication.
4. **Lead with the behavioral story.** "Here's proof fans will shift spending when given the option" is a story. "Here's a tool that shows payout rates" is not.

### Existing drafts (update before using)
- [drafts/pitch-hypebot.md](drafts/pitch-hypebot.md) — original pitch, needs reframing
- [drafts/press-release-dmn.md](drafts/press-release-dmn.md) — DMN press release format
- [drafts/pitch-the-verge.md](drafts/pitch-the-verge.md) — on hold

---

## Content cadence

### Monthly rhythm

| Week | Content type | Example |
| ---- | ------------ | ------- |
| 1 (Bandcamp Friday) | Platform spotlight + social push | "It's Bandcamp Friday — here's how to find your favorites" |
| 2 | Artist economics post | "What happens to your $9.99/month Spotify subscription" |
| 3 | Platform discovery guide | "You can stream music for free with your library card" |
| 4 | Product update / changelog | "New: Unstream now searches Mirlo and Jam.coop" |

### Social cadence

* **Launch phase (weeks 1-4):** 2 posts/week across platforms
* **Steady state (week 5+):** Ramp to 3 posts/week
* **Maximum:** 1 post/day
* **Bandcamp Friday:** Always post the Thursday before + day-of

---

## Execution timeline

Growth is community-led right now. Press is on hold until there's a behavioral story. Brandon posts organically on Threads, Bluesky, and Mastodon.

| Priority | Action | Deadline | Status |
|----------|--------|----------|--------|
| 1 | Reach out to UMAW about recommending Unstream | April 2026 | Not started |
| 1 | Propose ListenBrainz integration on MetaBrainz forum | April 2026 | Not started |
| 2 | Pitch public libraries (NYPL, Brooklyn, LA) with one-pager | April-May 2026 | Not started |
| 2 | Prepare May 2 Bandcamp Friday content kit | April 24 | Not started |
| 3 | Build organic reporter relationships on Threads/Bluesky | Ongoing | In progress |
| 3 | Reddit "I built this" post | When traction warrants it | Not started |
| 4 | Resume press outreach with behavioral story | When usage justifies it | On hold |

---

## Metrics to track

| Metric | Current tool | Target |
| ------ | ------------ | ------ |
| Monthly searches | GoatCounter (/search events) | 2x in 90 days |
| Extension installs | Chrome Web Store / Mozilla dashboard | Track weekly |
| Liberapay donations | Liberapay dashboard | Track monthly |
| Platform click-throughs | GoatCounter (/go/{platform}) | Track which platforms drive most interest |
| Artist directory growth | Supabase | Track monthly |
| Social engagement | Platform native analytics | Track weekly |

---

## Open questions

1. Paid promotion budget — any, or purely organic?
2. Blog/changelog on unstream.stream — should we create one for product updates?
3. What behavioral metric threshold triggers resuming press outreach? (200 WAU? 500? UMAW endorsement alone?)
