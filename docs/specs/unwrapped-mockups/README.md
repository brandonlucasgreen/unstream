# Unwrapped mockups (2026-11-19)

Mockups for [`../unwrapped-spec.md`](../unwrapped-spec.md), kept for when Unwrapped is picked up
again in 2027. They were drawn on a Claude Design canvas
(https://claude.ai/artifact/GCqWtvjLgqb3wzAzY7BBxg, private to Brandon); these are its source files.

**They are not standalone pages.** Each `.dc.html` is a Design Component: plain HTML and inline
styles inside an `<x-dc>` element, with `{{holes}}` and a small script for the interactive ones. They
load a `support.js` runtime that only the canvas provides, so opening one in a browser shows the
markup without the logic. Read them as source, or open the canvas. `canvas.json` is the canvas
layout: where each artboard sits and what it's called.

All artist names, prices, counts and dates are sample data. The payout ranges are the real ones from
`api/shared/platform-registry.ts` as of November 2026.

| File | What it shows |
|---|---|
| `Main.dc.html` | Mac popover entry point |
| `ExtensionPopup.dc.html` | Extension popup entry point |
| `ExtensionNowPlaying.dc.html` | Extension now playing, artist on your plan |
| `PlayLogSettings.dc.html` | Mac app play count setting |
| `ExtensionSettings.dc.html` | Extension: turning play counts off |
| `SignInGate.dc.html` | `/unwrapped/2026` signed out |
| `Recap1Cover.dc.html` … `Recap6Budget.dc.html` | The full recap, with play counts |
| `MinimalCover.dc.html`, `MinimalList.dc.html` | The recap without play counts |
| `StarterList.dc.html` | "Start your list", for fans with under two saved artists |
| `PlanPage.dc.html` | The plan, desktop |
| `ShareCard.dc.html` | Share image |
| `PublicPage.dc.html` | Public page, `/u/{handle}/2026` |
| `ReminderEmail.dc.html` | Bandcamp Friday reminder email |

The play-count settings that shipped on 2026-11-19 differ from `PlayLogSettings` and
`ExtensionSettings`: no per-artist table, and no confirmation before deleting. The spec's §4.0 has
what was built.
