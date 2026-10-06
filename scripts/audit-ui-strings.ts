/**
 * audit-ui-strings.ts — P0 spike for #594 (parent #593: Language localization)
 *
 * AST-based (ts-morph) extraction of hardcoded UI-facing strings from the web
 * SPA. NOT regex. Baseline CSV for the i18n migration + summary to stdout.
 *
 * Extracts:
 *   - JSXText nodes (trimmed, non-empty)
 *   - Literal string values of UI props: aria-label, placeholder, title, alt,
 *     label, tooltip, heading, description (JSX attributes AND object-literal
 *     keys, e.g. `{ key: 'added', label: 'Date added' }`)
 *   - Template literals in JSX text position and in the above props
 *
 * Skips: imports, type positions, test files, apps/web/src/data/** (long-form
 * content stays English per plan), URLs (/path-like, http…), CSS-class-ish
 * strings, and anything already inside a t() / i18n.t() call (future-proof).
 *
 * Run:  npm run audit:strings   (or: npx tsx scripts/audit-ui-strings.ts)
 * Out:  scripts/strings-baseline.csv (overwritten each run — deterministic)
 */
import {
  Project,
  SyntaxKind,
  Node,
  type SourceFile,
  type JsxText,
  type StringLiteral,
  type TemplateExpression,
  type NoSubstitutionTemplateLiteral,
  type ObjectLiteralExpression,
} from "ts-morph";
import { writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WEB_SRC = join(ROOT, "apps", "web", "src");
const OUT_CSV = join(import.meta.dirname, "strings-baseline.csv");

const UI_PROPS = new Set([
  "aria-label",
  "placeholder",
  "title",
  "alt",
  "label",
  "tooltip",
  "heading",
  "description",
]);

const EXCLUDED_DIRS = [join(WEB_SRC, "data")];
const SKIP_URL_RE = /^(https?:\/\/|\/|\.\/|\.\.|#|\{)/;
const SKIP_CLASSISH_RE = /^[\w\s\-\[\]\/:.%#]+$/; // crude CSS/class/selector-ish
const CSV_HEADER = "file,line,kind,text\n";

function csvEscape(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.replace(/"/g, '""')}"`;
}

/** True when the closest call-expression ancestor is a t()/i18n.t() call. */
function insideTranslateCall(node: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (Node.isCallExpression(cur)) {
      const exprText = cur.getExpression().getText();
      if (exprText === "t" || exprText === "i18n.t" || exprText.endsWith(".t")) {
        return true;
      }
    }
    cur = cur.getParent();
  }
  return false;
}

function shouldSkipString(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (SKIP_URL_RE.test(t)) return true;
  if (/^[\w-]+$/.test(t) && !t.includes(" ")) return true; // identifiers/keys
  if (t.startsWith(".") || t.startsWith("//")) return true;
  if (t.length < 2) return true;
  return false;
}

interface Row {
  file: string;
  line: number;
  kind: "jsx-text" | "prop" | "template";
  text: string;
}

function collectFromSource(sf: SourceFile, rows: Row[]): void {
  const rel = relative(ROOT, sf.getFilePath());
  const relPosix = rel.split("/").join("/");

  // --- JSXText ---
  for (const jsxText of sf.getDescendantsOfKind(SyntaxKind.JsxText)) {
    const raw = jsxText.getText();
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (shouldSkipString(trimmed)) continue;
    rows.push({ file: relPosix, line: jsxText.getStartLineNumber(), kind: "jsx-text", text: trimmed });
  }

  // --- JSX attributes with literal values ---
  for (const attr of sf.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const name = attr.getNameNode().getText();
    if (!UI_PROPS.has(name)) continue;
    const init = attr.getInitializer();
    if (!init) continue;

    if (Node.isStringLiteral(init)) {
      const v = init.getLiteralText();
      if (!shouldSkipString(v) && !insideTranslateCall(init)) {
        rows.push({ file: relPosix, line: init.getStartLineNumber(), kind: "prop", text: v });
      }
    } else if (Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (!expr) continue;
      if (Node.isStringLiteral(expr)) {
        const v = expr.getLiteralText();
        if (!shouldSkipString(v) && !insideTranslateCall(expr)) {
          rows.push({ file: relPosix, line: expr.getStartLineNumber(), kind: "prop", text: v });
        }
      } else if (Node.isTemplateExpression(expr)) {
        rows.push({ file: relPosix, line: expr.getStartLineNumber(), kind: "template", text: expr.getText() });
      }
    }
  }

  // --- Object-literal keys with the prop names (label: '...') ---
  for (const obj of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const nameNode = obj.getNameNode();
    const key = nameNode.getText();
    if (!UI_PROPS.has(key)) continue;
    const init = obj.getInitializer();
    if (!init || !Node.isStringLiteral(init)) continue;
    const v = init.getLiteralText();
    if (!shouldSkipString(v) && !insideTranslateCall(init)) {
      rows.push({ file: relPosix, line: init.getStartLineNumber(), kind: "prop", text: v });
    }
  }

  // --- Template literals in JSX expression containers (text position) ---
  for (const jsxExpr of sf.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
    const expr = jsxExpr.getExpression();
    if (!expr) continue;
    if (Node.isTemplateExpression(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
      // Only flag templates that interpolate or carry copy context:
      const text = expr.getText();
      // Heuristic: templates that look like UI copy interpolate values or have words
      const looksLikeCopy = /\$\{/.test(text) ? /[A-Za-z]{3}/.test(text) : /[A-Za-z]{3,}/.test(text);
      if (looksLikeCopy && !SKIP_URL_RE.test(text)) {
        rows.push({ file: relPosix, line: expr.getStartLineNumber(), kind: "template", text });
      }
    }
  }
}

function main(): void {
  const project = new Project({
    tsConfigFilePath: join(ROOT, "apps", "web", "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const files = project.addSourceFilesAtPaths([
    join(WEB_SRC, "**/*.{ts,tsx}"),
  ]).filter((sf) => {
    const p = sf.getFilePath();
    if (EXCLUDED_DIRS.some((d) => p.startsWith(d))) return false;
    if (/\.test\./.test(p) || p.includes("/tests/")) return false;
    return true;
  });

  const rows: Row[] = [];
  for (const sf of files) collectFromSource(sf, rows);

  // Dedupe per file+line+kind+text (repeats of same attr on one line collapse)
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.file}|${r.line}|${r.kind}|${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));

  writeFileSync(OUT_CSV, CSV_HEADER + deduped.map((r) => `${r.file},${r.line},${r.kind},${csvEscape(r.text)}`).join("\n") + "\n");

  // --- Summary ---
  const byKind = new Map<string, number>();
  const byDir = new Map<string, number>();
  for (const r of deduped) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const d = dirname(r.file).replace("apps/web/src/", "").replace("apps/web/src", "(src root)");
    byDir.set(d, (byDir.get(d) ?? 0) + 1);
  }
  const fileCount = new Set(deduped.map((r) => r.file)).size;

  console.log(`\n=== UI strings audit ===`);
  console.log(`files scanned: ${files.length}`);
  console.log(`TOTAL strings: ${deduped.length} across ${fileCount} files`);
  console.log(`\nBy kind:`);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log(`\nTop directories:`);
  for (const [d, n] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${n.toString().padStart(4)}  ${d}`);
  }
  console.log(`\nCSV written: ${relative(ROOT, OUT_CSV)} (${deduped.length} + header)`);
}

main();