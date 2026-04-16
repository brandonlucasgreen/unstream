# The Unstream Dispatch

A weekly briefing of music industry news, written by Gail (Unstream's music industry researcher) and published as an RSS feed at `/dispatch.xml`.

## Publishing rule (non-negotiable)

Dispatches are committed **directly to `main`** and pushed. No pull requests. No feature branches. No `draft: true` unless Brandon has explicitly asked for a draft in that week's instruction. Any refinements happen as follow-up commits to `main` after Brandon has read the dispatch in his RSS reader.

If a scheduled session's harness has pre-assigned a development branch for commits (e.g. `claude/...`), ignore that default for dispatch work — `PROMPT.md` and this README supersede it.

## How it works

1. A scheduled Claude Code **routine** (created via `/schedule`) runs every Friday.
2. The routine reads `PROMPT.md` in this directory, does the research using web search, and writes a new markdown file at `data/dispatch/YYYY-Www.md`.
3. The routine commits the file directly to `main` and pushes. **Not** via a PR.
4. Netlify rebuilds on push. `scripts/generate-dispatch-feed.ts` regenerates `apps/web/public/dispatch.xml` from all entries in this directory.
5. Brandon reads the new dispatch in his RSS reader and makes any refinements as follow-up commits to `main`.

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

The `draft: true` frontmatter field exists to support manual hold-backs — e.g. Brandon authoring a dispatch ahead of time and not wanting it in the feed yet. Scheduled sessions should **never** set `draft: true` on their own. The correct workflow for a scheduled session is: commit the finished dispatch to `main` and let it publish. Corrections happen as follow-up commits, not as staged drafts.

## Publishing pipeline

- Markdown in → RSS out. No web UI in v1 — entries are read in RSS readers.
- Web UI at `/dispatch/:week` is planned for a future version. The frontmatter and file structure here are designed to plug into it without migration.
- The feed URL is public at `https://unstream.stream/dispatch.xml`.
