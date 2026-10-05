/**
 * Facade import-direction guard for the git trajectory facade (bd
 * tea-rags-mcp-rwhhc).
 *
 * `domains/trajectory/git/index.ts` is the git subdomain barrel: it already
 * re-exports every capability the `GitTrajectory` facade in `git.ts` assembles
 * (provider, filters, payload signal descriptors, presets, derived signals,
 * stats accumulators). Importing `./git/provider.js`, `./git/filters.js` or
 * `./git/payload-signals.js` directly past that barrel is the
 * leakingAbstraction BYPASS kind — same shape the language verticals fixed
 * for their walker barrels (bd tea-rags-mcp-89k7k.30): the barrel vouches for
 * a public surface the facade does not itself consume, so the barrel cannot
 * re-shape the subdomain without auditing the facade by hand.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/language/facade-walker-barrel.test.ts`: a source-level
 * scan of runtime named import statements. `import type` clauses are erased
 * at compile time and stay legal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const FACADE = "src/core/domains/trajectory/git.ts";
const BARREL = "src/core/domains/trajectory/git/index.ts";

interface RuntimeImport {
  names: string[];
  specifier: string;
}

/**
 * Named-form import statements carrying at least one RUNTIME clause.
 * `import type { A }` is erased at compile time; a mixed statement
 * (`import { f, type T }`) is runtime because `f` is a value edge.
 */
function runtimeImports(text: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const isTypeStatement = match[0].startsWith("import type");
    const names = match[1]
      .split(",")
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !/^type\s+/.test(clause));
    if (isTypeStatement || names.length === 0) continue;
    imports.push({ names, specifier: match[2] });
  }
  return imports;
}

describe("the git trajectory facade imports the git subdomain through its barrel", () => {
  it("no facade runtime-imports a ./git/* file other than ./git/index.js", () => {
    const offenders: string[] = [];
    const text = readFileSync(join(ROOT, FACADE), "utf-8");
    for (const statement of runtimeImports(text)) {
      if (!statement.specifier.startsWith("./git/")) continue;
      if (statement.specifier === "./git/index.js") continue;
      offenders.push(`${FACADE}: ${statement.names.join(", ")} from "${statement.specifier}"`);
    }
    expect(offenders).toEqual([]);
  });

  it("the git barrel exposes the names the facade consumes through it", () => {
    const barrel = readFileSync(join(ROOT, BARREL), "utf-8");
    for (const statement of runtimeImports(readFileSync(join(ROOT, FACADE), "utf-8"))) {
      if (statement.specifier !== "./git/index.js") continue;
      for (const name of statement.names) {
        expect(barrel, `${BARREL} must re-export "${name}" for ${FACADE}`).toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });
});
