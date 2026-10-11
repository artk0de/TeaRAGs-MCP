/**
 * Composition-root direction guard (bd tea-rags-mcp-k7kmu C5, h4a H2a).
 *
 * `.claude/rules/domain-boundaries.md` gives `bootstrap/` the import set
 * `mcp/`, `core/api/`, `core/{contracts, primitives, adapters}/`. Domain
 * modules are reached only through the api ASSEMBLY barrel
 * (`core/api/index.ts`) — or, for config-time reads that must not load the
 * whole api graph, through a narrow `core/api/*.ts` re-export file
 * (`pool-sizing.ts`, `registry-env-replay.ts`).
 *
 * The pin: no file under `src/bootstrap/` holds an import or re-export
 * (value OR type, static OR dynamic) whose specifier resolves into
 * `src/core/domains/**` or `src/core/api/internal/**`.
 *
 * Worker entry modules handed to a pool BY PATH (the codegraph provider
 * factory, the language module, the enrichment worker) are `join(...)`
 * string paths, not imports: they load in another thread or process and are
 * out of this guard's scope.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAP_DIR = "src/bootstrap";

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/** Every module specifier the file imports or re-exports, static or dynamic. */
function moduleSpecifiers(text: string): string[] {
  const patterns = [/\bfrom\s*"([^"]+)"/g, /\bimport\s*"([^"]+)"/g, /\bimport\s*\(\s*"([^"]+)"\s*\)/g];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

function resolveRelative(fileRel: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const segments = [...fileRel.split("/").slice(0, -1), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function reachesPastTheApiBarrel(path: string): boolean {
  return path.startsWith("src/core/domains/") || path.startsWith("src/core/api/internal/");
}

describe("bootstrap reaches domain modules only through core/api", () => {
  it("no file under src/bootstrap imports from core/domains/** or core/api/internal/**", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(BOOTSTRAP_DIR)) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const specifier of moduleSpecifiers(text)) {
        const resolved = resolveRelative(file, specifier);
        if (resolved !== undefined && reachesPastTheApiBarrel(resolved)) offenders.push(`${file}: "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner sees multi-line, type-only and dynamic imports", () => {
    const text = [
      'import {\n  A,\n  B,\n} from "../core/domains/x/index.js";',
      'import type { T } from "../core/api/internal/y.js";',
      'const m = await import("../core/domains/z.js");',
      'const path = join(__dirname, "../core/domains/worker.js");',
    ].join("\n");
    expect(moduleSpecifiers(text)).toEqual([
      "../core/domains/x/index.js",
      "../core/api/internal/y.js",
      "../core/domains/z.js",
    ]);
  });
});
