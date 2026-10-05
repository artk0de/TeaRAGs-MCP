/**
 * Facade import-direction guard for the language verticals' walker barrels
 * (bd tea-rags-mcp-89k7k.30).
 *
 * Each language vertical owns a `walker/` subdomain with an `index.ts` barrel
 * that the vertical's own facade RE-EXPORTS from — the facade's re-export is
 * the barrel's adoption proof. Importing `./walker/walker.js`,
 * `./walker/name-of.js` or `./walker/passes.js` directly past that barrel is
 * the leakingAbstraction BYPASS kind: the facade vouches for a public surface
 * it does not itself consume, so the barrel cannot vouch for (or re-shape) the
 * walker capability without auditing the facade by hand.
 *
 * Mirrors the mechanism of
 * `tests/core/api/public/sdp-runtime-import-direction.test.ts`: a source-level
 * scan of runtime named import statements, resolved relative to the importing
 * file. `import type` clauses are erased at compile time and stay legal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The five language verticals whose root facade fronts a walker subdomain. */
const VERTICALS = ["javascript", "python", "ruby", "swift", "typescript"] as const;

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

describe("language vertical facades import the walker capability through the walker barrel", () => {
  it("no vertical facade runtime-imports a ./walker/* file other than ./walker/index.js", () => {
    const offenders: string[] = [];
    for (const vertical of VERTICALS) {
      const file = `src/core/domains/language/${vertical}/index.ts`;
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.startsWith("./walker/")) continue;
        if (statement.specifier === "./walker/index.js") continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every walker barrel exposes the names its facade consumes", () => {
    for (const vertical of VERTICALS) {
      const facadeRel = `src/core/domains/language/${vertical}/index.ts`;
      const barrelRel = `src/core/domains/language/${vertical}/walker/index.ts`;
      const barrel = readFileSync(join(ROOT, barrelRel), "utf-8");
      for (const statement of runtimeImports(readFileSync(join(ROOT, facadeRel), "utf-8"))) {
        if (statement.specifier !== "./walker/index.js") continue;
        for (const name of statement.names) {
          expect(barrel, `${barrelRel} must re-export "${name}" for ${facadeRel}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
