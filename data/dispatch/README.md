# The Unstream Dispatch

A weekly briefing of music industry news, written by Gail (Unstream's music industry researcher) and published as an RSS feed at `/dispatch.xml`.

## How it works

1. A scheduled Claude Code **routine** (created via `/schedule`) runs every Friday.
2. The routine reads `PROMPT.md` in this directory, does the research using web search, and writes a new markdown file at `data/dispatch/YYYY-Www.md`.
3. The routine commits to a `claude/dispatch-YYYY-Www` branch and opens a pull request.
4. Brandon reviews, refines, and merges the PR.
5. On merge, Netlify rebuilds. `scripts/generate-dispatch-feed.ts` regenerates `apps/web/public/dispatch.xml` from all entries in this directory.

## Dispatch format

Each dispatch is a markdown file named `YYYY-Www.md` (ISO week number — e.g. `2026-W16.md`).

Required frontmatter:

```yaml
---
title: "Week of April 17, 2026"
week: 2026-W16
published: 2026-04-17
summary: "One-line teaser for the feed"
---
```

Body is markdown. The body becomes the `<content:encoded>` of the RSS item.

Set `draft: true` in frontmatter to exclude a dispatch from the feed (useful when a routine opens a PR and you want to hold it back from publishing while refining).

## Publishing pipeline

- Markdown in → RSS out. No web UI in v1 — entries are read in RSS readers.
- Web UI at `/dispatch/:week` is planned for a future version. The frontmatter and file structure here are designed to plug into it without migration.
- The feed URL is public at `https://unstream.stream/dispatch.xml`.
