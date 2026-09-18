/**
 * `JavascriptImportFileMapper` — which project file a JavaScript import names
 * (bd tea-rags-mcp-x9qsh).
 *
 * A relative specifier names its file only when it writes the extension.
 * `"./config"` is `config.js` in one project and `config/index.js` in the
 * next, and `"./styles/static.scss"` is not a code file at all — yet the old
 * file edge named `config.js` and `static.scss.js` from the specifier alone,
 * paths no file row can match. This mapper walks the candidates in the order a
 * resolver tries them and answers from symbol-table MEMBERSHIP (`hasFile`), so
 * `project` is always a file the index holds. No disk, per the
 * `ImportFileMapper` contract: pass 2 runs against a hydrated table whose
 * working tree may have moved on.
 *
 * `unknown` is a relative specifier the index holds no file for — a directory
 * the index skips (`../build/...`), a stylesheet, an image. It is NOT
 * `external`: only a bare package specifier is, which is what
 * `mapJavascriptImportToFile` has always answered `null` for and
 * `JavascriptCallResolver#targetsExternalImport` reads as external.
 */

import { posix } from "node:path";

import type { CallContext, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";

const EXTERNAL: ImportFileTarget = { kind: "external" };
const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/**
 * Suffixes that make a relative specifier name its file as written. The
 * TypeScript ones are what a JS entry point writes when it loads TS source
 * directly (`node --experimental-strip-types`, tsx); appending `.js` to them
 * named `worker.ts.js`, a file that cannot exist (bd tea-rags-mcp-x9qsh).
 * `.d.ts` / `.d.mts` / `.d.cts` are covered by their last segment. `.json` is
 * the JSON module `require("../package.json")` names.
 */
const EXPLICIT_MODULE_EXTENSIONS: readonly string[] = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
];

/**
 * Extensions tried for a specifier that writes none, JavaScript first. `.js`
 * leads because it is what Node's CommonJS resolution tries and what
 * {@link javascriptImportPathCandidates}' head — the unverified answer the call
 * path uses — has always been. The TypeScript pair closes the list for a
 * bundler project whose JavaScript imports a TypeScript module extensionless,
 * the mirror of the TypeScript mapper's `allowJs` tail; last, so a JavaScript
 * file beside it always wins.
 */
const EXTENSIONLESS_MODULE_EXTENSIONS: readonly string[] = [".js", ".jsx", ".ts", ".tsx"];

/** Basename of the module a directory stands for: `"./config"` → `config/index.js`. */
const DIRECTORY_MODULE_STEM = "index";

/**
 * Repo-relative files a JavaScript specifier could name, in resolution order,
 * or `null` for a bare package specifier (npm packages, `node:` builtins —
 * codegraph excludes `node_modules` from the walk).
 *
 * A specifier that writes an extension names exactly one file. One that writes
 * none is a file first and then a directory, via its `index` module — the order
 * Node's `require` and every bundler resolve them in. A dotted basename
 * (`./foo.service`) writes no extension the list knows, so it is extensionless
 * too, and reaches `foo.service.js`.
 */
export function javascriptImportPathCandidates(importText: string, callerFile: RelPath): readonly RelPath[] | null {
  if (!importText.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(callerFile), importText));
  if (EXPLICIT_MODULE_EXTENSIONS.some((extension) => joined.endsWith(extension))) return [joined];
  return [
    ...EXTENSIONLESS_MODULE_EXTENSIONS.map((extension) => `${joined}${extension}`),
    ...EXTENSIONLESS_MODULE_EXTENSIONS.map((extension) => `${joined}/${DIRECTORY_MODULE_STEM}${extension}`),
  ];
}

export class JavascriptImportFileMapper implements ImportFileMapper {
  mapImportToFile(importText: string, fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const candidates = javascriptImportPathCandidates(importText, fromFile);
    if (candidates === null) return EXTERNAL;
    const relPath = candidates.find((candidate) => ctx.symbolTable.hasFile(candidate));
    return relPath === undefined ? UNKNOWN : { kind: "project", relPath };
  }
}
