# The Unstream Dispatch

A weekly briefing of music industry news, delivered to the `#unstream-dispatch` Discord channel (`1494159048461910138`).

## How it works

1. The cron job `8e17d673-…` runs every Friday (Fridays 7 AM ET per `HEARTBEAT.md`).
2. The cron job spawns Katy in `mode: "run"` with the brief defined inline in the cron job definition itself.
3. Katy's output is delivered to `#unstream-dispatch` only — NOT to DM.
4. The cron job is defined in OpenClaw; the brief lives in the cron job's `payload.message` field.

## Historical context

The dispatch used to be:

- **2026-04-17 and earlier:** committed to `main` as a markdown file (`data/dispatch/YYYY-Www.md`), published as an RSS feed at `unstream.stream/dispatch.xml` by `scripts/generate-dispatch-feed.ts` on Netlify rebuild. Files from that era (e.g. `2026-W16.md`) and the old prompt (`PROMPT.md.bak-pre-discord-2026-04-17`) are kept in this directory for the historical record.
- **2026-04-17 → present:** delivered to Discord only. RSS publishing was retired.
- **2026-06-18:** the agent slot was reorganized. The old slot ID (which used to write the dispatch) was renamed to `Stewart` (legal/finance/tax research, dormant) and a new `Roald` (ops/infra/security) slot was created on the reclaimed ID. Katy continues to own the dispatch under her own (unchanged) slot ID. See `MEMORY.md` "Agent roster" for the current slot layout.

The previous `PROMPT.md` and the old "commit directly to main" workflow described in the pre-2026-04-17 docs are dead. The current brief lives in the cron job definition; if you're a future agent reading this for context, look at the cron job `8e17d673-…` for the actual prompt.

## Dispatch format (legacy / RSS)

The pre-Discord dispatches used this format:

- File: `data/dispatch/YYYY-Www.md` (ISO week number)
- Required frontmatter:
  ```yaml
  ---
  title: "Week of April 17, 2026"
  week: 2026-W16
  published: 2026-04-17
  summary: "One-line teaser for the feed"
  ---
  ```
- Body is markdown. Body becomes the `<content:encoded>` of the RSS item.

The `scripts/generate-dispatch-feed.ts` script and the Netlify rebuild pipeline still work, but new dispatches are no longer written to this directory. The historical files (`2026-W16.md`, etc.) are kept so the RSS feed at `unstream.stream/dispatch.xml` continues to render the archive.
