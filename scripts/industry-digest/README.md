# Industry digest

A weekly digest of music-industry news relevant to Unstream, compiled by an Ollama cloud model
and published as an RSS feed. It's for Brandon, not for the site: unlisted, not private.

**Feed:** https://raw.githubusercontent.com/brandonlucasgreen/unstream/industry-digest/feed.xml

## How it runs

`.github/workflows/industry-digest.yml` runs every Friday at 11:17 UTC (7:17am ET), or by hand
from the Actions tab. It:

1. **Gathers** the last seven days from the feeds in `sources.ts`, plus the web searches there
   (Ollama's `web_search` API, which is billed to the same key).
2. **Selects** up to 90 candidates: de-duplicated by URL, at most 12 per source, and nothing a
   digest from the last four weeks already cited.
3. **Compiles** with one chat call. The model is given numbered stories and replies with JSON
   that cites them by number (`digest.ts` has the prompt).
4. **Publishes** `{week}.md`, `{week}.json` and a rebuilt `feed.xml` (last 26 issues) to the
   `industry-digest` branch.

Re-running in the same ISO week replaces that week's issue under the same guid, so a reader
shows it once.

## Why it's built this way

- **The model never writes a link.** It cites story numbers; links are rendered from what was
  actually fetched, and a story citing a number that was never handed out is dropped (and named
  in the run summary). A hallucinated story can't arrive with a plausible URL.
- **Its own branch, not `main`.** A commit to `main` deploys the website (a Netlify build
  each Friday for a file that isn't part of the site) and would put the digest in the repo
  everyone reads. The branch holds only the digest; the repo is public, so the raw URL works in
  any feed reader without a login. Anyone who goes browsing the repo's branches can find it,
  which is the meaning of unlisted.
- **Feeds first, search second.** Feeds have dates; search results don't, so the model is told
  to keep a search result only if its text shows it's from this week.
- **One dead feed doesn't stop the run.** It's a warning in the run summary's source table. The
  run fails only if every feed fails, the model's reply is invalid twice, or nothing is left.

## Setup

- **Secret** `OLLAMA_API_KEY`: from ollama.com → Settings → Keys. Repo → Settings → Secrets and
  variables → Actions → New repository secret.
- **Variable** `DIGEST_MODEL` (optional): any Ollama cloud model; default `gpt-oss:120b`. If the
  configured model isn't served, the run fails and lists the ones that are.

## Changing it

- Sources: edit `sources.ts`. The run summary's table shows which feeds work.
- What the digest covers and how it reads: `buildSystemPrompt` in `digest.ts`.
- Trying a change without publishing:
  `OLLAMA_API_KEY=… npx tsx scripts/industry-digest/run.ts --out /tmp/digest` writes the files
  to a scratch directory; `--gather-only` prints the candidates and skips the model.

Tests: `apps/web/tests/unit/industry-digest.test.ts`.
