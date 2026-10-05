/**
 * Barrel import-direction guard for the ingest infra barrel (bd
 * tea-rags-mcp-xgzyv, wave 2 of the barrel-discipline sweep).
 *
 * `domains/ingest/infra/index.ts` is the infra subdomain barrel
 * (`.claude/rules/barrel-files.md` rule 3: cross-subdomain imports MUST go
 * through the barrel). A direct `infra/collection-stats.js` or
 * `infra/stats-recompute.js` import from api/internal is the
 * leakingAbstraction BYPASS kind — same shape the rwhhc sweep pinned for the
 * public contract surface
 * (`tests/core/api/public/contract-surface-barrel.test.ts`): the barrel
 * vouches for a surface the consumer does not take, so the subdomain cannot
 * re-shape its internals without auditing the bypasser by hand.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/trajectory/git-facade-barrel.test.ts`: a source-level
 * scan of runtime named import statements. `import type` clauses are erased
 * at compile time and stay legal.
 *
 * The pin is per-file, not directory-wide: other api/internal files
 * (`facades/ingest-facade.ts`, `composition.ts`, the remaining ops files
 * among them) still import infra files directly and are tracked outside this
 * sweep.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The api/internal files this wave pinned to the infra barrel. */
const PINNED_CONSUMERS = [
  "src/core/api/internal/ops/explore-ops.ts",
  "src/core/api/internal/ops/indexing-ops.ts",
] as const;

const BARREL = "src/core/domains/ingest/infra/index.ts";

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

describe("api/internal consumers import ingest infra through its barrel", () => {
  it("no pinned consumer runtime-imports an infra file other than the barrel", () => {
    const offenders: string[] = [];
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.includes("/domains/ingest/infra/")) continue;
        if (statement.specifier.endsWith("domains/ingest/infra/index.js")) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the infra barrel exposes the names the pinned consumers take through it", () => {
    const barrel = readFileSync(join(ROOT, BARREL), "utf-8");
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.endsWith("domains/ingest/infra/index.js")) continue;
        for (const name of statement.names) {
          expect(barrel, `${BARREL} must re-export "${name}" for ${file}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
