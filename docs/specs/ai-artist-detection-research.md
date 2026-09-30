---
status: Done
---
# AI-Artist Detection: Research & Decision

> Status: **Done — no artist-level AI badge shipped** (30 September 2026). Research only; no code
> changed. Direct access to `musicbrainz.org`, `wikidata.org`, `api.deezer.com` and Supabase was
> blocked from the research environment, so §2's Wikidata and Deezer details are from published
> documentation and search summaries, not live queries. §5 lists what to verify before revisiting.

## 1. The question

Could a search result say "this is an AI artist" (or "verified human"), from a public API, cheaply
enough to badge? And are AI acts common enough in Unstream's own artist data to need purging?

Unstream already answers the **platform**-level version: `aiPolicy` / `aiPolicyUrl` in
`api/shared/platform-registry.ts` drive the "AI policy" chip on `SourceBadge`. This is about the
**artist**.

## 2. What exists

No free, public, artist-level API from a trustworthy source returns an AI verdict. The platforms
that flag AI do it in their own apps only.

| Source | Level | Definition | Public API? |
|---|---|---|---|
| Deezer | Album | Fully AI-generated, detected from audio (Suno/Udio traces), appealable | No field documented in `api.deezer.com`; the detector is licensed B2B by quote |
| Spotify | Track (DDEX credits); artist ("AI Persona" / "Likely AI Persona", "Verified by Spotify") | Credits are label-declared; Persona labels an AI-made *identity*, not the music | No: no credits endpoint, and the Web API was cut back in Feb 2026 |
| Qobuz | Release | 100% AI-generated, detected in-house | No |
| Tidal | Release | Wholly AI-generated, via a detection partner | No |
| Apple Music | Track / artwork / composition | Label-supplied Transparency Tags | Not found |
| DDEX ERN 4.3.2 | Recording / contribution | Self-declared, fully or partly AI | B2B delivery format, no registry |
| Wikidata | Artist (item, linked to MBID via P434) | Editors' judgement from sources | Yes, CC0. Pattern: P2079 "fabrication method" = Q117246174 "generative AI"; genre Q131597985 "AI-generated music" |
| MusicBrainz tags | Artist / release / recording | None: no guideline, anyone can tag | Yes (`inc=tags`), but tags are CC BY-NC-SA, not CC0 |
| Community lists (CennoxX `spotify-ai-blocker`, Soul Over AI, eye-wave) | Artist, by Spotify ID | Suspicion / "judgment by ear"; 70% of Soul Over AI entries had no disclosure | GitHub files, no API. Soul Over AI shut down Feb 2026, citing mislabelling risk |
| Audio detectors (IRCAM Amplify, Vobile/Pex, Cyanite, AI or Not) | Track | Audio analysis | Paid, and need audio Unstream doesn't host |
| "Verified human" schemes (Verified Human, Humanable, Not By AI) | Track or self-applied badge | Mostly self-attested | Verified Human has a free ISRC lookup; tiny coverage |

**Definitions matter more than sources.** "AI-generated" (Deezer, Qobuz, Tidal: wholly made by a
model), "AI-assisted" (DDEX, Apple: any AI contribution, down to mastering), and "AI persona"
(Spotify: a synthetic identity) are three different claims. Only the first means "AI artist" in
the sense a fan cares about, and it's the one nobody exposes.

## 3. What Unstream's data shows

Checked by normalized name against the two community lists (the only AI data reachable):

| Unstream list | vs CennoxX (7,357 names) | vs Soul Over AI (1,375 names) |
|---|---|---|
| `data/artist-list.json` (3,000 Wikidata artists) | 6 | 0 |
| `data/artists/` (791 generated pages) | 6 | 0 |

Every hit is a well-known human act: Kiesza, Aurora, X, ABC, Luna, Zoé, Iris, Gary. Most are name
collisions with an unrelated Spotify act. **Kiesza is not a collision**: CennoxX lists her real
Spotify ID (`4zxvC7CRGvggq9EWXOpwAo`). Her only publicised AI link is one AI-assisted song on
SKYGGE's 2018 album *Hello World*. The best-maintained community list has labelled a human artist
as an AI artist, the failure mode that would matter most here.

Not checked: the ~128 claimed profiles and the Supabase `artists` table beyond the files above
(no database access). Claimed profiles pass ownership verification, and Unstream's platforms
mostly ban AI music, so the expected count there is also near zero.

**No purge is warranted.**

## 4. Decision

No AI badge on results. In product terms:

- **Expected hits are near zero.** AI acts live on streaming services. Bandcamp, Mirlo, Ampwall
  and Subvert ban AI music, and Beatport, Qobuz and Ko-fi publish formal AI policies. Those are
  the destinations Unstream exists to surface.
- **A false "AI" badge on a human artist is the worst outcome available**, and the sources with
  real coverage (community lists, MusicBrainz tags) produce them. This is the dedup rule again:
  under-flag, never over-flag. Artists first.
- **A "human-made" badge would overclaim.** Bans on those platforms are enforced after reports,
  so presence is evidence, not proof. The per-platform "AI policy" chip already says exactly
  as much as is known.

## 5. If this is revisited

The one source that is both accurate and free is **Wikidata**, and it fits the existing Phase 2
lookup at almost no cost:

1. `search-musicbrainz.ts` already fetches `inc=url-rels`; MusicBrainz's `wikidata` relation
   gives the QID with no extra MusicBrainz request.
2. One `wbgetclaims` call for P2079 / P136 against that QID. `www.wikidata.org` is already on the
   SSRF allowlist.
3. The whole Phase 2 result is cached via `cacheGetOrFetch`, so it adds no Redis commands.
4. A failed Wikidata fetch means "unknown", never "human" (never cache uncertainty).

It would only fire for press-notable acts (The Velvet Sundown, Q135207113, and similar). Before
building it, from an unblocked machine:

- Confirm Q117246174 / Q131597985 and count the items using them with a P434 (MBID). If it's a
  few dozen acts, none of which Unstream returns, it's still not worth the code.
- Check whether `api.deezer.com/album/<id>` carries any AI field (e.g. album 897206042, reported
  as Deezer-flagged). If it does, it's the best-coverage source and would change this decision.

Don't use community lists or MusicBrainz tags as a trigger, for the reasons in §3.
