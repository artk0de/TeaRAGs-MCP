/**
 * `infra/symbolid` facade adoption (bd tea-rags-mcp-k5t63): the module is
 * consumed ONLY through its `index.js` facade — 29 of 30 importers already
 * did, and the one deep import (`kernel/symbol-id.ts` reaching
 * `classify.js` for `INSTANCE_METHOD_SEPARATOR`) is exactly what the
 * leakingAbstraction detector flags live: an import past an adopted facade.
 *
 * A source-scan guard (the `tests/source-nul-bytes.test.ts` pattern): the
 * detector needs a built index to see the violation, while this test pins the
 * boundary on every suite run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const CORE_SRC = join(REPO_ROOT, "src", "core");
const FACADE_DIR = join(CORE_SRC, "infra", "symbolid");

/** Every `.ts` file under `dir`, recursively, as absolute paths. */
function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * Import specifiers reaching INTO `infra/symbolid` past its `index.js` —
 * matched on import STATEMENTS (`from` / `import` forms), never on prose:
 * docblocks name these modules in backticks and apostrophes, and a bare
 * quote-delimited scan false-positives on them.
 */
const deepSymbolidImports = (source: string): string[] =>
  [
    ...source.matchAll(/(?:from|import\()\s*["']([^"']*infra\/symbolid\/[^"']*)["']/g),
    ...source.matchAll(/^import\s*["']([^"']*infra\/symbolid\/[^"']*)["']/gm),
  ]
    .map((match) => match[1])
    .filter((specifier) => !specifier.endsWith("index.js"));

describe("infra/symbolid facade adoption", () => {
  it("no file outside the facade imports its modules deep — only index.js crosses the boundary", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(CORE_SRC)) {
      if (file.startsWith(FACADE_DIR + sep)) continue; // the facade's own internals import relatively
      offenders.push(...deepSymbolidImports(readFileSync(file, "utf8")).map((specifier) => `${file}: ${specifier}`));
    }
    expect(offenders).toEqual([]);
  });
});
