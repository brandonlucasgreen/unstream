# Shared locale dictionaries

Source of truth for every translatable string in the Unstream web SPA. The
web client imports these files directly at build time (Vite resolves JSON
natively), so they are bundled, not fetched.

## Layout

```
locales/
  en/
    common.json   # nav, footer, search chrome, generic CTAs, language switcher
    artist.json   # homepage hero/marketing copy, search results states
    tips.json     # fan-facing tipping surfaces (TipPage, TipThanksPage, artist panel)
```

Keys are namespaced by *where the string lives*, not by URL — `nav.*`,
`footer.*`, `results.*`, `cta.*`, `hero.*`. A key describes the surface, so the
same string on two surfaces gets two keys and can be translated differently
later (e.g. `nav.platforms` vs `footer.platforms`).

## Why no i18next plurals yet

English is the only language and the only two counts in the migrated slice
(`Found N result(s)`, `Verify (N)`) are handled with explicit sibling keys —
`results.foundOne` / `results.foundMany` and `nav.admin.verifyCount`. That keeps
every value a plain string, so the audit script, the dictionary diff, and
`t()` calls stay trivial and reviewable.

Plural **suffixes** (`_one` / `_other`) and i18next's `count` option should be
adopted in the first phase that adds a language whose plural rules differ from
English (e.g. Polish, Arabic). Until then, inventing plural machinery for one
language is dead weight that every future key would have to pay for.

## Interpolation

Values may contain `{{count}}` / `{{name}}` placeholders. `escapeValue` is left
at i18next's default (`true`) — no React `dangerouslySetInnerHTML`, and no
trusted-HTML flag per key. Every value renders as text.

## Adding a language (P2+)

1. Add `locales/<lng>/{common,artist,tips}.json`.
2. Register the resource bundle and add the code to the supported list in
   `apps/web/src/i18n.ts`.
3. Add a label to `languages` in that file (drives `LanguageSwitcher`).
4. Run `npm run verify`.
