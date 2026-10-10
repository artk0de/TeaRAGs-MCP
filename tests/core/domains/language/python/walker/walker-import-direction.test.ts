/**
 * Import-direction pin for the Python root ↔ walker/resolver composition
 * (bd tea-rags-mcp-0qaht.37.1).
 *
 * The layering report kept the python knot (A133: python, python/resolver,
 * python/resolver/strategies, python/resolver/dispatch, python/walker) alive
 * after U2. The walker and the resolver strategies import the root's leaf
 * modules (`vocabulary/`, `capability.ts`, `generator-context-manager-marker.ts`)
 * — a nested module depending on its language's contracts-only leaves, the
 * same shape every other vertical has. What closed the cycle was the root
 * FACADE reaching past the resolver's facade into
 * `resolver/python-known-target-callee-locator.ts`: a facade-to-facade edge
 * that re-exports is composition, a facade-to-internal edge is a real
 * root → resolver dependency, and with strategies → root it is a loop.
 *
 * So the root composes walker and resolver through their `index.ts` facades
 * only, and the walker never reaches the root facade or the resolver:
 *
 *   root → walker/index · root → resolver/index · walker/strategies → root leaves
 *
 * Strict model — an `import type` counts too, because the layering detector
 * sees type edges. Mirrors
 * `tests/core/domains/language/ruby/walker/walker-import-direction.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../../");
const PYTHON_ROOT = "src/core/domains/language/python";
const WALKER_ROOT = `${PYTHON_ROOT}/walker`;
const RESOLVER_ROOT = `${PYTHON_ROOT}/resolver`;
const ROOT_FACADE = `${PYTHON_ROOT}/index.ts`;
const WALKER_FACADE = `${WALKER_ROOT}/index.ts`;
const RESOLVER_FACADE = `${RESOLVER_ROOT}/index.ts`;

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/** The `.ts` files directly in the python root — the facade and its leaf siblings. */
function rootFiles(): string[] {
  return readdirSync(join(ROOT, PYTHON_ROOT))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${PYTHON_ROOT}/${entry}`);
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

describe("the python root composes walker and resolver through their facades only", () => {
  it("no python root file reaches into python/walker/ past walker/index.ts", () => {
    const offenders = importEdges(rootFiles())
      .filter((edge) => edge.target.startsWith(`${WALKER_ROOT}/`) && edge.target !== WALKER_FACADE)
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });

  it("no python root file reaches into python/resolver/ past resolver/index.ts", () => {
    const offenders = importEdges(rootFiles())
      .filter((edge) => edge.target.startsWith(`${RESOLVER_ROOT}/`) && edge.target !== RESOLVER_FACADE)
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });
});

describe("the python walker never imports upward into the root facade or across into the resolver", () => {
  it("no file under python/walker/ imports python/index.ts", () => {
    const offenders = importEdges(tsFilesUnder(WALKER_ROOT))
      .filter((edge) => edge.target === ROOT_FACADE)
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });

  it("no file under python/walker/ imports anything under python/resolver/", () => {
    const offenders = importEdges(tsFilesUnder(WALKER_ROOT))
      .filter((edge) => edge.target.startsWith(`${RESOLVER_ROOT}/`))
      .map((edge) => `${edge.file}: "${edge.specifier}"`);
    expect(offenders).toEqual([]);
  });
});
