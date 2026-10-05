/**
 * Barrel import-direction guard for the worktree seed subdomain (bd
 * tea-rags-mcp-rwhhc).
 *
 * `domains/maintenance/worktree/index.ts` is the subdomain barrel
 * (`export *` over its files, the worktree-seed-source capability among
 * them). An api/internal runtime import of
 * `domains/maintenance/worktree/worktree-seed-source.js` directly past it is
 * the leakingAbstraction BYPASS kind: the barrel vouches for a public surface
 * the consumer does not take.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/language/facade-walker-barrel.test.ts` (bd
 * tea-rags-mcp-89k7k.30): a source-level scan of runtime named import
 * statements. `import type` clauses are erased at compile time and stay
 * legal. The scan covers api/internal only — files inside
 * `domains/maintenance/` import siblings directly, which is legal within one
 * domain.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const INTERNAL_DIR = "src/core/api/internal";
const BARREL_SUFFIX = "domains/maintenance/worktree/index.js";

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

function tsFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      entries.push(...tsFiles(rel));
    } else if (name.endsWith(".ts")) {
      entries.push(rel);
    }
  }
  return entries;
}

describe("api/internal imports the worktree subdomain through its barrel", () => {
  it("no api/internal file runtime-imports a maintenance/worktree file other than the barrel", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(INTERNAL_DIR)) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        if (!statement.specifier.includes("domains/maintenance/worktree/")) continue;
        if (statement.specifier.endsWith(BARREL_SUFFIX)) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
