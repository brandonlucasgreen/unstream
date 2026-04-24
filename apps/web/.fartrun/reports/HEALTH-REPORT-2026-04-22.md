# Health Report: web

Scanned: 2026-04-22 22:56
Total findings: 88 (actionable: 73)

🟡 medium: 23 | 🔵 low: 50 | ℹ️ info: 15

**Files:** 95
**Entry points:** server/search/index.ts, src/App.tsx, src/types/index.ts

## Recommended action order

1. extract reusable components (10 items)
2. extract duplicates (5 items)
3. split large files (4 items)
4. remove dead code (2 items)
5. gitignore (1 items)
6. readme (1 items)

---

## 🟡 MEDIUM (23)

> Monster files are hard for AI to work with — context window limits mean Claude can't see the whole file at once. Split to improve AI-assisted development.

- [ ] **Monster: src/pages/ClaimPage.tsx**
  - src/pages/ClaimPage.tsx — 668 lines, 28 functions.
  - **Fix (Python docs):**
    ### Package Directory Structure - Python Module Organization
    Source: https://github.com/python/cpython/blob/main/Doc/reference/import.rst
    Shows the recommended directory layout for a Python package with subpackages and modules. This structure is used as reference for understanding relative import paths and module organization.
    ```text
    package/
        __init__.py
        subpackage1/
            __init__.py
            moduleX.py
            moduleY.py
        subpackage2/
            __init__.py

- [ ] **Monster: src/services/sources.ts**
  - src/services/sources.ts — 655 lines, 30 functions.
  - **Fix (Python docs):**
    ### Package Directory Structure - Python Module Organization
    Source: https://github.com/python/cpython/blob/main/Doc/reference/import.rst
    Shows the recommended directory layout for a Python package with subpackages and modules. This structure is used as reference for understanding relative import paths and module organization.
    ```text
    package/
        __init__.py
        subpackage1/
            __init__.py
            moduleX.py
            moduleY.py
        subpackage2/
            __init__.py

- [ ] **Monster: src/pages/ArtistEditPage.tsx**
  - src/pages/ArtistEditPage.tsx — 628 lines, 28 functions.
  - **Fix (Python docs):**
    ### Package Directory Structure - Python Module Organization
    Source: https://github.com/python/cpython/blob/main/Doc/reference/import.rst
    Shows the recommended directory layout for a Python package with subpackages and modules. This structure is used as reference for understanding relative import paths and module organization.
    ```text
    package/
        __init__.py
        subpackage1/
            __init__.py
            moduleX.py
            moduleY.py
        subpackage2/
            __init__.py

- [ ] **Monster: tests/unit/search-parsers.test.ts**
  - tests/unit/search-parsers.test.ts — 513 lines, 60 functions.
  - **Fix (Python docs):**
    ### Package Directory Structure - Python Module Organization
    Source: https://github.com/python/cpython/blob/main/Doc/reference/import.rst
    Shows the recommended directory layout for a Python package with subpackages and modules. This structure is used as reference for understanding relative import paths and module organization.
    ```text
    package/
        __init__.py
        subpackage1/
            __init__.py
            moduleX.py
            moduleY.py
        subpackage2/
            __init__.py

> Dead code confuses AI assistants and developers. If a function isn't called, it's either forgotten or accessed via framework magic — verify before deleting.

- [ ] **Unused function: hasSocialIcon**
  - hasSocialIcon() in src/components/SocialIcon.tsx — defined but never called anywhere in the project.
  - **Fix (Python docs):**
    ### dis Function
    Source: https://github.com/python/cpython/blob/main/Doc/library/dis.rst
    Disassemble Python objects including modules, classes, methods, functions, generators, coroutines, code objects, source code strings, or raw bytecode sequences. Supports recursive disassembly with configurable depth and display options.
    ```APIDOC
    ## dis Function
    ### Description
    Disassemble Python objects to bytecode instructions with support for recursive analysis and multiple display options.
    ### Method
    ANALYZE (analysis function)
    ### Signature
    ```python
    dis.dis(x=None, *, file=None, depth=None, show_caches=False, adaptive=False, show_offsets=False, show_positions=False)

- [ ] **Unused function: ArtistAuthBar**
  - ArtistAuthBar() in src/components/ArtistAuthBar.tsx — defined but never called anywhere in the project.
  - **Fix (Python docs):**
    ### dis Function
    Source: https://github.com/python/cpython/blob/main/Doc/library/dis.rst
    Disassemble Python objects including modules, classes, methods, functions, generators, coroutines, code objects, source code strings, or raw bytecode sequences. Supports recursive disassembly with configurable depth and display options.
    ```APIDOC
    ## dis Function
    ### Description
    Disassemble Python objects to bytecode instructions with support for recursive analysis and multiple display options.
    ### Method
    ANALYZE (analysis function)
    ### Signature
    ```python
    dis.dis(x=None, *, file=None, depth=None, show_caches=False, adaptive=False, show_offsets=False, show_positions=False)

> Duplicated code means fixing a bug in one place leaves the same bug alive in the copy. Extract shared logic into a common module.

- [ ] **2 duplicate blocks: src/App.tsx ↔ src/pages/ArtistPage.tsx**
  - Total: ~69 duplicated lines. Extract shared logic into a common module.
  - Lines: ↔144 (47L), ↔266 (22L)

- [ ] **Duplicate: server/shared-types.ts ↔ src/types/index.ts (12 lines)**
  - 12 duplicate lines: server/shared-types.ts:2 and src/types/index.ts:3.
  - **Fix (Python docs):**
    ### Test class mixin for code reuse in Python unittest
    Source: https://github.com/python/cpython/blob/main/Doc/library/test.rst
    A mixin class pattern for reducing code duplication in tests by extracting common test logic. This approach allows multiple test classes to inherit shared test methods while varying specific inputs or configurations, promoting DRY principles in test suites.
    ```python
    class TestFuncAcceptsSequencesMixin:
        func = mySuperWhammyFunction
        def test_func(self):
            self.func(self.arg)
    ```
    --------------------------------
    ### Refactored def statement replacing lambda
    Source: https://github.com/python/cpython/blob/main/Doc/howto/functional.rst

- [ ] **Duplicate: src/components/PasswordSection.tsx ↔ src/pages/ResetPasswordPage.tsx (12 lines)**
  - 12 duplicate lines: src/components/PasswordSection.tsx:19 and src/pages/ResetPasswordPage.tsx:21.
  - **Fix (Python docs):**
    ### Test class mixin for code reuse in Python unittest
    Source: https://github.com/python/cpython/blob/main/Doc/library/test.rst
    A mixin class pattern for reducing code duplication in tests by extracting common test logic. This approach allows multiple test classes to inherit shared test methods while varying specific inputs or configurations, promoting DRY principles in test suites.
    ```python
    class TestFuncAcceptsSequencesMixin:
        func = mySuperWhammyFunction
        def test_func(self):
            self.func(self.arg)
    ```
    --------------------------------
    ### Refactored def statement replacing lambda
    Source: https://github.com/python/cpython/blob/main/Doc/howto/functional.rst

- [ ] **Duplicate: src/pages/ArtistLoginPage.tsx ↔ src/pages/ClaimPage.tsx (10 lines)**
  - 10 duplicate lines: src/pages/ArtistLoginPage.tsx:149 and src/pages/ClaimPage.tsx:387.

> Repeated UI patterns should be extracted into shared components. Less code to maintain, consistent look, easier for AI to modify.

- [ ] **Extract reusable component: <W5H5 />**
  - <svg class='w-5 h-5'> appears 15 times in 6 files: src/App.tsx, src/components/SearchBar.tsx, src/components/ResultCardHeader.tsx.

- [ ] **Extract reusable component: <SpaceY2 />**
  - <div class='space-y-2'> appears 13 times in 8 files: src/components/ResultCardRelease.tsx, src/components/ResultCardActions.tsx, src/components/ResultCardPlatforms.tsx.

- [ ] **Extract reusable component: <TextXsTextTextMuted />**
  - <p class='text-xs text-text-muted'> appears 13 times in 4 files: src/components/PasswordSection.tsx, src/components/ArtistAnalytics.tsx, src/pages/ClaimPage.tsx.

- [ ] **Extract reusable component: <TextSmTextTextMuted />**
  - <p class='text-sm text-text-muted'> appears 12 times in 5 files: src/pages/ArtistLoginPage.tsx, src/pages/ResetPasswordPage.tsx, src/pages/ArtistDashboardPage.tsx.

- [ ] **Extract reusable component: <MinHScreen />**
  - <div class='min-h-screen'> appears 11 times in 11 files: src/App.tsx, src/pages/ExtensionPage.tsx, src/pages/PrivacyPolicyPage.tsx.

- [ ] **Extract reusable component: <Px4Pb16 />**
  - <main class='px-4 pb-16'> appears 10 times in 10 files: src/App.tsx, src/pages/ExtensionPage.tsx, src/pages/PrivacyPolicyPage.tsx.

- [ ] **Extract reusable component: <TextTextMutedTextSm />**
  - <p class='text-text-muted text-sm'> appears 9 times in 7 files: src/App.tsx, src/pages/ArtistLoginPage.tsx, src/pages/ArtistDirectoryPage.tsx.

- [ ] **Extract reusable component: <TextTextMuted />**
  - <p class='text-text-muted'> appears 9 times in 7 files: src/App.tsx, src/pages/RoadmapPage.tsx, src/pages/ArtistDashboardPage.tsx.

- [ ] **Extract reusable component: <W3.5H3.5 />**
  - <svg class='w-3.5 h-3.5'> appears 9 times in 3 files: src/components/SourceBadge.tsx, src/components/ResultCardActions.tsx, src/pages/ArtistPage.tsx.

- [ ] **Extract reusable component: <FlexItemsStartGap4 />**
  - <div class='flex items-start gap-4'> appears 8 times in 4 files: src/pages/ExtensionPage.tsx, src/pages/ClaimPage.tsx, src/pages/ImportPage.tsx.

- [ ] **No .gitignore file**
  - No .gitignore — you might be committing junk files.

- [ ] **No README file**
  - No README.


## 🔵 LOW (50)

- [ ] **Orphan: src/components/ResultCardTypes.ts**
  - src/components/ResultCardTypes.ts — nobody imports it, not an entry point.

- [ ] **Orphan: src/pages/ResetPasswordPage.tsx**
  - src/pages/ResetPasswordPage.tsx — nobody imports it, not an entry point.

- [ ] **Orphan: public/widget.js**
  - public/widget.js — nobody imports it, not an entry point.

- [ ] **Orphan: src/pages/GuidePage.tsx**
  - src/pages/GuidePage.tsx — nobody imports it, not an entry point.

- [ ] **Orphan: src/pages/ImportPage.tsx**
  - src/pages/ImportPage.tsx — nobody imports it, not an entry point.

> Bare except/empty catch blocks silently swallow errors. When something breaks, you won't know what or where. Log or handle specifically.

- [ ] **then_no_catch: server/search/index.ts:151**
  - server/search/index.ts:151 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: server/search/index.ts:160**
  - server/search/index.ts:160 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: server/search/index.ts:205**
  - server/search/index.ts:205 — .then() without .catch() — unhandled promise rejection.

- [ ] **empty_catch: server/search/bandcamp.ts:118**
  - server/search/bandcamp.ts:118 — Empty catch block — errors silently swallowed.

- [ ] **then_no_catch: public/widget.js:128**
  - public/widget.js:128 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: public/widget.js:128**
  - public/widget.js:128 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: public/widget.js:140**
  - public/widget.js:140 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: public/widget.js:140**
  - public/widget.js:140 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/App.tsx:105**
  - src/App.tsx:105 — .then() without .catch() — unhandled promise rejection.

- [ ] **empty_catch: src/App.tsx:180**
  - src/App.tsx:180 — Empty catch block — errors silently swallowed.

- [ ] **then_no_catch: src/main.tsx:10**
  - src/main.tsx:10 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:11**
  - src/main.tsx:11 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:12**
  - src/main.tsx:12 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:13**
  - src/main.tsx:13 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:14**
  - src/main.tsx:14 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:15**
  - src/main.tsx:15 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:16**
  - src/main.tsx:16 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:17**
  - src/main.tsx:17 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:18**
  - src/main.tsx:18 — .then() without .catch() — unhandled promise rejection.

- [ ] **then_no_catch: src/main.tsx:19**
  - src/main.tsx:19 — .then() without .catch() — unhandled promise rejection.

> Hardcoded values (URLs, ports, keys) break when environments change. Extract to config/env vars.

- [ ] **Hardcoded url: server/search/index.ts:107**
  - server/search/index.ts:107 — https://buymeacoffee.com/explore-creators.

- [ ] **Hardcoded url: server/search/faircamp.ts:15**
  - server/search/faircamp.ts:15 — https://faircamp.webr.ing/directory.json.

- [ ] **Hardcoded url: public/widget.js:5**
  - public/widget.js:5 — https://unstream.stream.

- [ ] **Hardcoded url: public/widget.js:98**
  - public/widget.js:98 — https://fonts.googleapis.com/css2?family=Golos+Text:wght@400.

- [ ] **Hardcoded url: src/App.tsx:137**
  - src/App.tsx:137 — https://letterbird.co/embed/v1.js.

- [ ] **Hardcoded url: src/App.tsx:252**
  - src/App.tsx:252 — https://chromewebstore.google.com/detail/unstream-support-mu.

- [ ] **Hardcoded url: src/App.tsx:263**
  - src/App.tsx:263 — https://addons.mozilla.org/en-US/firefox/addon/unstream/.

- [ ] **Hardcoded url: src/App.tsx:318**
  - src/App.tsx:318 — https://www.icloud.com/shortcuts/73296296361e4f609087746e7f0.

- [ ] **Hardcoded url: src/components/ResultCardActions.tsx:62**
  - src/components/ResultCardActions.tsx:62 — https://chromewebstore.google.com/detail/unstream-support-mu.

- [ ] **Hardcoded url: src/components/ResultCardActions.tsx:74**
  - src/components/ResultCardActions.tsx:74 — https://addons.mozilla.org/en-US/firefox/addon/unstream/.

- [ ] **Hardcoded url: src/components/Footer.tsx:7**
  - src/components/Footer.tsx:7 — https://bgreen.lol.

- [ ] **Hardcoded url: src/components/Footer.tsx:36**
  - src/components/Footer.tsx:36 — https://letterbird.co/hi-d2078591.

- [ ] **Hardcoded url: src/pages/ExtensionPage.tsx:74**
  - src/pages/ExtensionPage.tsx:74 — https://chromewebstore.google.com/detail/unstream-support-mu.

- [ ] **Hardcoded url: src/pages/ExtensionPage.tsx:86**
  - src/pages/ExtensionPage.tsx:86 — https://addons.mozilla.org/en-US/firefox/addon/unstream/.

- [ ] **Hardcoded url: src/pages/SupportPage.tsx:26**
  - src/pages/SupportPage.tsx:26 — https://liberapay.com/unstream.

- [ ] **Hardcoded url: src/pages/GuidePage.tsx:80**
  - src/pages/GuidePage.tsx:80 — https://bgreen.lol.

- [ ] **Hardcoded url: src/pages/GuidePage.tsx:107**
  - src/pages/GuidePage.tsx:107 — https://bgreen.lol.

- [ ] **Hardcoded url: src/pages/GuidePage.tsx:112**
  - src/pages/GuidePage.tsx:112 — https://unstream.stream.

- [ ] **Hardcoded url: src/pages/AdminMergePage.tsx:169**
  - src/pages/AdminMergePage.tsx:169 — https://....

- [ ] **Hardcoded url: src/pages/ClaimPage.tsx:462**
  - src/pages/ClaimPage.tsx:462 — https://linktr.ee/yourname.

- [ ] **Unfinished work: 3 uncommitted files, 1 stashed changes**
  - You have 3 uncommitted files, 1 stashed changes.

> Giant commits are hard to review, hard to revert, and hard for AI to understand. Keep commits focused on one change.

- [ ] **Big commit: e104227 (1458 lines)**
  - Commit 'refactor: split ResultCard.tsx into sub-components' changed 1458 lines.

- [ ] **Big commit: 1ca10da (3105 lines)**
  - Commit 'refactor: split server/api.ts into domain modules (#188)' changed 3105 lines.

- [ ] **Big commit: 7b19cf2 (1118 lines)**
  - Commit 'feat(ios): show featured artists in search empty state (#178)' changed 1118 lines.

- [ ] **JS/TS files but no package.json**
  - You have JavaScript/TypeScript files but no package.json.


---

## ⚠️ Possible false positives

The scanner uses static analysis and may flag valid code. Check these before blindly fixing:

- **map.modules**: Orphan detection doesn't track dynamic imports (importlib, __import__), lazy imports inside functions, or framework auto-discovery (Django admin autodiscover, pytest conftest). Files like `main.jsx`, `index.js`, `mongo-init.js` are often entry points loaded by bundlers or Docker — not real orphans.
- **dead.unused_definitions**: Functions/methods called dynamically (getattr, signals, event handlers) or exposed as public API may be flagged. Also: celery tasks discovered by name, pytest fixtures in conftest.py, and Django/DRF auto-discovered methods. Verify the function isn't called via string name or framework magic.
- **debt.no_reuse**: Reusable pattern detection skips HTML/RN primitives, but custom design system components with className may be intentionally repeated (e.g. consistent spacing divs). Use judgment.

---

<details>
<summary>ℹ️ Info (15 items)</summary>

- **Project Map**: In your project: 95 files. Most common: .tsx (39). This is just context — now you know what's inside.
- **Entry Points**: Entry point = the file where everything starts. Like doors to a building. You have 3.
- **Hub: src/components/Header.tsx**: src/components/Header.tsx is imported by 18 files. This is your most important module. Break it — break everything.
- **Hub: src/components/Footer.tsx**: src/components/Footer.tsx is imported by 17 files. This is your most important module. Break it — break everything.
- **Hub: src/contexts/AuthContext.tsx**: src/contexts/AuthContext.tsx is imported by 14 files. This is your most important module. Break it — break everything.
- **Tests: 8 files (unknown)**: 8 test files found (8 JS/TS). Framework: unknown.
- **Session: 1 commits, ~9 files touched**: Last 8 hours: 1 commits, ~9 files modified.
- **Before building — search first**: Before writing a new feature: google it. Check GitHub repos, PyPI, npm. Someone probably already built what you need. Don't reinvent the wheel — steal the wheel.
- **Git status: 1 staged (ready to commit), 2 untracked (new files git doesn't know about)**: Working tree: 1 staged (ready to commit), 2 untracked (new files git doesn't know about). Staged files are ready for commit. Untracked files won't be saved until you 'git add' them.
- **17 unmerged branches**: Branches not merged: + claude/beautiful-wright-ec8d1c, + claude/nifty-cartwright-5e617c, feat/ai-policy-indicator, feat/changelog-and-platform-guide, feat/product-analytics. (and 12 more) Merge or delete them to keep things clean.
- **Git commands you need right now**: git add <file> — start tracking a new file | git commit -m 'description' — save staged changes | git stash — temporarily hide changes, work on something else
- **Frontend project — use DevTools**: Can't explain to AI which button to change? F12 → click element → copy HTML and CSS → show AI. It'll understand.
- **UI Element Dictionary available**: Frontend project detected. Can't explain to AI which button to change? Open the UI Dictionary — 20 elements with names, pictures, and example prompts.
### LLM Context Summary

Copy this to give AI context about your project:
# Project: web

**Stack:** JavaScript/TypeScript, React

**Size:** 95 files, 20 dirs

**Entry points:**
- `server/search/index.ts` — JavaScript/TypeScript entry point
- `src/App.tsx` — JavaScript/TypeScript entry point
- `src/types/index.ts` — JavaScript/TypeScript entry point

**Key modules:**
- `src/components/Header.tsx` (imported by 18 files)
- `src/components/Footer.tsx` (imported by 17 files)
- `src/contexts/AuthContext.tsx` (imported by 14 files)
- `server/shared-utils.ts` (imported by 12 files)
- `src/services/sources.ts` (imported by 9 files)

- **Config Files**: 3 config files found.

</details>

---

## How to use this report with AI

Paste this file to Claude/Cursor and say:
```
Fix the issues in this health report, starting from HIGH severity.
Skip items marked as possible false positives.
```

---
*Scanned: [web](https://github.com/brandonlucasgreen/unstream) · Generated by [fartrun](https://github.com/ChuprinaDaria/Vibecode-Cleaner-Fartrun) · MCP: `npx fartrun@latest install`*