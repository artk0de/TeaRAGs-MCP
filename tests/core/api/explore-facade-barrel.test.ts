/**
 * Facade import-direction guard for the explore domain barrel (bd
 * tea-rags-mcp-xgzyv, wave 2 of the barrel-discipline sweep).
 *
 * `domains/explore/index.ts` is the explore facade barrel (`.claude/rules/
 * barrel-files.md` rule 1). A direct `explore/errors.js`,
 * `explore/queries/index-metrics.js` or `explore/strategies/index.js` import
 * from api/internal is the leakingAbstraction BYPASS kind — same shape the
 * rwhhc sweep pinned for the public contract surface
 * (`tests/core/api/public/contract-surface-barrel.test.ts`) and the git
 * trajectory fixed for its subdomain barrel
 * (`tests/core/domains/trajectory/git-facade-barrel.test.ts`): the barrel
 * vouches for a surface the consumer does not take, so the domain cannot
 * re-shape its internals without auditing the bypasser by hand.
 *
 * Mirrors the mechanism of `git-facade-barrel.test.ts`: a source-level scan
 * of runtime named import statements. `import type` clauses are erased at
 * compile time and stay legal.
 *
 * The pin is per-file, not directory-wide: other api/internal files
 * (`facades/explore-facade.ts` among them) still import `explore/errors.js`
 * directly and are tracked outside this sweep.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The api/internal file this wave pinned to the explore facade. */
const PINNED_CONSUMERS = ["src/core/api/internal/ops/explore-ops.ts"] as const;

const BARREL = "src/core/domains/explore/index.ts";

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

describe("api/internal consumers import the explore domain through its facade barrel", () => {
  it("no pinned consumer runtime-imports an explore file other than the facade barrel", () => {
    const offenders: string[] = [];
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.includes("/domains/explore/")) continue;
        if (statement.specifier.endsWith("domains/explore/index.js")) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the explore barrel exposes the names the pinned consumer takes through it", () => {
    const barrel = readFileSync(join(ROOT, BARREL), "utf-8");
    for (const file of PINNED_CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.endsWith("domains/explore/index.js")) continue;
        for (const name of statement.names) {
          expect(barrel, `${BARREL} must re-export "${name}" for ${file}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
