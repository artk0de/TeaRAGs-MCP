/**
 * Contract-surface barrel discipline for the api/internal consumers (bd
 * tea-rags-mcp-rwhhc).
 *
 * `api/public/index.ts` is the CONTRACT facade (the consumer surface rule in
 * `.claude/rules/domain-boundaries.md`) and `api/public/dto/index.ts` is the
 * DTO barrel it re-exports through; the public barrel carries ~50 importers
 * against 13 for `public/errors.js` alone, so a direct `public/errors.js` /
 * `public/dto/<file>.js` import past it is the leakingAbstraction BYPASS
 * kind: the public barrel vouches for a surface the internal consumer does
 * not take.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/language/facade-walker-barrel.test.ts` (bd
 * tea-rags-mcp-89k7k.30): a source-level scan of runtime named import
 * statements in the four files this sweep pinned. `import type` clauses are
 * erased at compile time and stay legal. The pin is per-file, not
 * directory-wide: other api/internal files still import `public/errors.js` /
 * `public/dto/*.js` directly and are tracked outside this sweep.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The api/internal files the sweep pinned to the contract surface. */
const PINNED_CONSUMERS = [
  "src/core/api/internal/collection-resolver.ts",
  "src/core/api/internal/ops/document-metadata-schema.ts",
  "src/core/api/internal/ops/explore-ops.ts",
  "src/core/api/internal/ops/indexing-ops.ts",
] as const;

/** The only two api/public entry points a pinned consumer may runtime-import. */
const BARREL_SPECIFIER = /public\/(?:index|dto\/index)\.js$/;

const PUBLIC_BARREL = "src/core/api/public/index.ts";
const DTO_BARREL = "src/core/api/public/dto/index.ts";

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

describe("api/internal contract consumers import the public surface through its barrels", () => {
  it("no pinned consumer runtime-imports an api/public file other than the two barrels", () => {
    const offenders: string[] = [];
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.includes("/public/")) continue;
        if (BARREL_SPECIFIER.test(statement.specifier)) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every barrel exposes the runtime names its pinned consumers take through it", () => {
    const publicBarrel = readFileSync(join(ROOT, PUBLIC_BARREL), "utf-8");
    const dtoBarrel = readFileSync(join(ROOT, DTO_BARREL), "utf-8");
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!BARREL_SPECIFIER.test(statement.specifier)) continue;
        const barrel = statement.specifier.endsWith("dto/index.js") ? dtoBarrel : publicBarrel;
        const barrelRel = statement.specifier.endsWith("dto/index.js") ? DTO_BARREL : PUBLIC_BARREL;
        for (const name of statement.names) {
          expect(barrel, `${barrelRel} must re-export "${name}" for ${file}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
