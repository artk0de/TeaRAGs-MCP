/**
 * Import-direction pin for the Ruby walker (bd tea-rags-mcp-0qaht.37, U3).
 *
 * The layering report measured `ruby/walker` and `ruby/walker/type-sources` as
 * a composition cycle (A141): the walker imports its type sources downward,
 * while the type sources reached back UP into the walker's shared AST helpers
 * — and `type-sources/ast-inference.ts` reached across into
 * `resolver/type-propagation.ts` for the container vocabularies. The fix makes
 * `walker/shared/` its own leaf module (an `index.ts` barrel over the
 * contracts-only helpers), moves the container vocabularies into it, and
 * routes every importer through that barrel:
 *
 *   walker → walker/shared · type-sources → walker/shared · walker → type-sources
 *
 * which is acyclic, and the walker never reaches the resolver at all — so the
 * module-eval hazard of an inline type source pulling resolver code that leads
 * back into `walker/walker.js` cannot recur.
 *
 * Strict model — an `import type` counts too, because the layering detector
 * sees type edges. Mirrors the mechanism of
 * `tests/core/domains/language/kernel/kernel-leaf-import-direction.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../../");
const RUBY_ROOT = "src/core/domains/language/ruby";
const WALKER_ROOT = `${RUBY_ROOT}/walker`;
const RESOLVER_ROOT = `${RUBY_ROOT}/resolver`;
const SHARED_ROOT = `${WALKER_ROOT}/shared`;
const TYPE_SOURCES_ROOT = `${WALKER_ROOT}/type-sources`;
const SHARED_BARREL = `${SHARED_ROOT}/index.ts`;

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

function importEdges(files: readonly string[]): { file: string; specifier: string; target: string }[] {
  const edges: { file: string; specifier: string; target: string }[] = [];
  for (const file of files) {
    for (const specifier of relativeSpecifiers(readFileSync(join(ROOT, file), "utf-8"))) {
      edges.push({ file, specifier, target: resolveSpecifier(file, specifier) });
    }
  }
  return edges;
}

describe("the ruby walker never imports upward or across into the resolver", () => {
  it("no file under ruby/walker/ imports anything under ruby/resolver/", () => {
    const offenders = importEdges(tsFilesUnder(WALKER_ROOT))
      .filter((edge) => edge.target.startsWith(`${RESOLVER_ROOT}/`))
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });

  it("walker/shared/ is a module with an index.ts barrel", () => {
    expect(statSync(join(ROOT, SHARED_BARREL)).isFile()).toBe(true);
  });

  it("no file outside walker/shared/ reaches a shared helper past the shared barrel", () => {
    const offenders = importEdges(tsFilesUnder(WALKER_ROOT).filter((file) => !file.startsWith(`${SHARED_ROOT}/`)))
      .filter((edge) => edge.target.startsWith(`${SHARED_ROOT}/`) && edge.target !== SHARED_BARREL)
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });

  it("walker/type-sources/ imports nothing from the walker except through walker/shared/", () => {
    const offenders = importEdges(tsFilesUnder(TYPE_SOURCES_ROOT))
      .filter(
        (edge) =>
          edge.target.startsWith(`${WALKER_ROOT}/`) &&
          !edge.target.startsWith(`${TYPE_SOURCES_ROOT}/`) &&
          edge.target !== SHARED_BARREL,
      )
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });

  it("walker/shared/ imports nothing from the rest of the ruby vertical", () => {
    const offenders = importEdges(tsFilesUnder(SHARED_ROOT))
      .filter((edge) => edge.target.startsWith(`${RUBY_ROOT}/`) && !edge.target.startsWith(`${SHARED_ROOT}/`))
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });
});
