/**
 * Compiled-JS detection — a STRICTER, JS-specific "do not index at all" signal,
 * deliberately kept separate from the broad `isGenerated` flag so the
 * generated-but-indexed policy (e.g. `db/schema.rb`) is NOT regressed.
 *
 * A compiled / minified / vendored JS bundle (e.g. huginn's
 * `vendor/assets/javascripts/d3.js`, 268KB) is a readable-but-compiled artefact
 * that both blows the tree-sitter parse budget (~51s, bead 9oq5e) and pollutes a
 * code RAG. The scanner drops the common asset DIRS by path (see
 * `ignore-defaults.ts`); this module is the CONTENT net for a bundle that slips
 * through under an ordinary source path.
 *
 * Two signals — either fires:
 *   (a) a source-map comment (`//# sourceMappingURL=` / legacy `//@ ...`),
 *   (b) minified — the longest physical line exceeds a length threshold.
 *
 * Lives in `infra/file-classification` (it owns content-marker detection via
 * `GENERATED_CONTENT_MARKERS`). Foundation layer: imports nothing from `core/`.
 */

import { extname } from "node:path";

import { installedFileClassificationSettings } from "./settings.js";

export { DEFAULT_MINIFIED_LINE_LENGTH } from "./settings.js";

/**
 * JS-family extensions the content gate applies to — TypeScript's ESM / CJS
 * module formats included, since ingest indexes them (bd tea-rags-mcp-1y13c).
 */
const JS_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

/**
 * Source-map comment, anchored to line start (optionally indented). Matches both
 * the modern `//#` and the legacy `//@` pragma forms. Anchoring to line start
 * avoids matching the literal substring inside a string/comment mid-line.
 */
const SOURCE_MAP_COMMENT = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=/m;

/**
 * Path-extension gate: is this a JS-family file the content check applies to?
 * Extension-based (not language-map) so `.mjs`/`.cjs` — which the language
 * detector maps to "unknown" — are still covered.
 */
export function isJsFamilyPath(filePath: string): boolean {
  return JS_FAMILY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Length of the longest physical line, single-pass. Both `\n` and `\r` are
 * treated as line terminators, so a CRLF file does not inflate the count by the
 * carriage return. Empty input → 0.
 */
export function maxLineLength(code: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i);
    if (ch === 10 /* \n */ || ch === 13 /* \r */) {
      if (current > max) max = current;
      current = 0;
    } else {
      current++;
    }
  }
  if (current > max) max = current;
  return max;
}

/**
 * Does this JS source look compiled (and therefore should NOT be indexed)?
 * Fires on a source-map comment OR a line longer than `minifiedLineLength` —
 * the operator's `TEA_RAGS_MINIFIED_LINE_THRESHOLD` as bootstrap installed it
 * (`./settings.ts`) unless the caller passes one. Pure given its arguments and
 * the installed settings; caller gates on {@link isJsFamilyPath}.
 */
export function isCompiledJsContent(
  code: string,
  minifiedLineLength: number = installedFileClassificationSettings().minifiedLineLength,
): boolean {
  if (SOURCE_MAP_COMMENT.test(code)) return true;
  return maxLineLength(code) > minifiedLineLength;
}
