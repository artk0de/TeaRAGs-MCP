/**
 * Import-direction pin for the Ruby resolver root (bd tea-rags-mcp-0qaht.37, U3).
 *
 * The layering report measured `ruby/resolver` and `ruby/resolver/strategies`
 * as a composition cycle (A111): the orchestrator imports `strategies/`
 * downward, while strategies reached back UP into root helpers
 * (`short-name-lookup`, `type-propagation`, `ruby-type-member-lookup`, ...).
 * The fix follows the Rust layout: the resolver root keeps only the
 * orchestrator, the `index.ts` barrel and orchestrator-only helpers; every
 * module a nested component consumes lives below the root.
 *
 * This test pins the direction: no file under `ruby/resolver/<sub>/**` may
 * import a file that sits directly in `ruby/resolver/`. Strict model — an
 * `import type` counts too, because the layering detector sees type edges.
 * Mirrors the mechanism of
 * `tests/core/domains/language/kernel/kernel-leaf-import-direction.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../../");
const RESOLVER_ROOT = "src/core/domains/language/ruby/resolver";

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/** Every relative module specifier a file names: static import/export, side-effect import, dynamic import(). */
function relativeSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)"(\.{1,2}\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

/** Repo-relative path a relative specifier resolves to, `.js` mapped back to `.ts`. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  return posix.normalize(posix.join(dirname(fromFile), specifier)).replace(/\.js$/, ".ts");
}

describe("ruby resolver nested components never import the resolver root", () => {
  it("no file under ruby/resolver/<sub>/ imports a file directly in ruby/resolver/", () => {
    const offenders: string[] = [];
    const nested = tsFilesUnder(RESOLVER_ROOT).filter((file) => dirname(file) !== RESOLVER_ROOT);
    expect(nested.length).toBeGreaterThan(0);
    for (const file of nested) {
      for (const specifier of relativeSpecifiers(readFileSync(join(ROOT, file), "utf-8"))) {
        const target = resolveSpecifier(file, specifier);
        if (dirname(target) === RESOLVER_ROOT) offenders.push(`${file}: "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
