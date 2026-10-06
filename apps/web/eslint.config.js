import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // ---------------------------------------------------------------------
  // Hardcoded UI strings (i18n readiness — see #593 / #594)
  // New UI copy must go through i18next's t(). Warn-level until Brandon
  // flips it to 'error'; NOT wired into CI. Baseline CSV lives at
  // scripts/strings-baseline.csv (regenerate: npm run audit:strings).
  // ---------------------------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/data/**', 'src/tests/**', '**/*.test.*'],
    rules: {
      // JSX text nodes: <div>Hello</div>
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'JSXText[value=/\\S/]',
          message: "Hardcoded UI string — use t() from i18next (see #593). Baseline: scripts/strings-baseline.csv.",
        },
        // Literal JSX props: <X placeholder="…" /> (incl. expression containers)
        {
          selector:
            "JSXAttribute[name.name=/(aria-label|placeholder|title|alt|label|tooltip|heading|description)/][value.type='Literal']",
          message: "Hardcoded UI string (literal prop) — use t() from i18next (see #593).",
        },
        {
          selector:
            "JSXAttribute[name.name=/(aria-label|placeholder|title|alt|label|tooltip|heading|description)/] TemplateLiteral",
          message: "Hardcoded UI string (template prop) — use t() from i18next (see #593).",
        },
        // Object-literal keys used as config copy: { label: '…' }
        {
          selector:
            "Property[key.name=/(aria-label|placeholder|title|alt|label|tooltip|heading|description)/][value.type='Literal']",
          message: "Hardcoded UI string (object copy) — use t() from i18next (see #593).",
        },
      ],
    },
  },
])
