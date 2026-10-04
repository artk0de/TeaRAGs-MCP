/**
 * Structural guard: the Python vertical's import graph is ACYCLIC (bd
 * tea-rags-mcp-0qaht.35).
 *
 * The layering knot the architecture report flagged among
 * `resolver/strategies`, `resolver` and `resolver/dispatch` had exactly ONE
 * file-level cycle: `resolver/python-import-file-mapper.ts` imported
 * `lookupPythonSymbolsByShortName` from `resolver/strategies/shared.js` while
 * `shared.ts` imported the `PythonImportFileMapper` TYPE back — parent
 * resolver reaching into child strategies, the direction the TypeScript knot
 * established as the defect (child strategies consuming parent resolver
 * helpers is the established direction). The fix mirrors Ruby's
 * `ruby/resolver/short-name-lookup.ts` (bd tea-rags-mcp-kumq2): the
 * short-name entry point lives in the resolver-root LEAF
 * `resolver/short-name-lookup.ts`, and `strategies/shared.ts` re-exports it so
 * existing import paths keep working.
 *
 * A cycle here is not a style finding: the resolver is wired per run over a
 * module graph where every consumer assumes it can load any helper without a
 * circular-initialisation hazard (a `const` read at module scope from a module
 * still mid-initialisation answers `undefined`), and the architecture
 * diagnostics aggregate these same edges into component knots.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** The Python vertical under `src/core/domains/language/python/`. */
const PYTHON_ROOT = resolve(import.meta.dirname, "../../../../../../src/core/domains/language/python");

/** One file's project-relative path -> the files its import/export statements name. */
function pythonImportGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const files = readdirSync(PYTHON_ROOT, { recursive: true, encoding: "utf8" })
    .map((entry) => join(PYTHON_ROOT, entry))
    .filter((file) => file.endsWith(".ts") && statSync(file).isFile());
  for (const file of files) {
    // Comments carry prose like `from a import b` (walker contract docblocks);
    // strip them so only real module statements name edges.
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const imports: string[] = [];
    const specifier = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(specifier)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const target =
        [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")].find(
          (candidate) => candidate.endsWith(".ts") && statSync(candidate, { throwIfNoEntry: false })?.isFile(),
        ) ?? null;
      if (target !== null) imports.push(relative(PYTHON_ROOT, target).split(/[\\/]/).join("/"));
    }
    graph.set(relative(PYTHON_ROOT, file).split(/[\\/]/).join("/"), imports);
  }
  return graph;
}

/** Tarjan SCC over the import graph; every non-trivial SCC is a cycle. */
function stronglyConnectedComponents(graph: Map<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const connect = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (let popped = stack.pop(); ; popped = stack.pop()) {
        onStack.delete(popped!);
        component.push(popped!);
        if (popped === node) break;
      }
      components.push(component);
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) connect(node);
  return components;
}

describe("python resolver import graph", () => {
  it("is acyclic — no file of the python vertical imports, directly or transitively, back into itself", () => {
    const graph = pythonImportGraph();
    const cycles = stronglyConnectedComponents(graph).filter((component) => component.length > 1);
    expect(
      cycles.map((cycle) => cycle.sort()),
      `import cycles under src/core/domains/language/python/ (parent resolver files must not reach into child strategies — see resolver/short-name-lookup.ts)`,
    ).toEqual([]);
  });
});
