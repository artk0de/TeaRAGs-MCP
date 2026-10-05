/**
 * Barrel import-direction guard for the Ruby resolver (bd tea-rags-mcp-rwhhc).
 *
 * Three subdomains border the resolver top level, each with an `index.ts`
 * barrel: `ruby/resolver/strategies/`, `language/kernel/` and
 * `ruby/dsl/`. A runtime import of a file inside one of them past its barrel
 * (`./strategies/shared.js`, `../../kernel/symbol-kind-roles.js`,
 * `../dsl/rails.js`) is the leakingAbstraction BYPASS kind: the barrel
 * vouches for a public surface the resolver does not take, so the barrel
 * cannot re-shape the subdomain without auditing the importer by hand.
 *
 * Mirrors the mechanism of
 * `tests/core/domains/language/facade-walker-barrel.test.ts` (bd
 * tea-rags-mcp-89k7k.30): a source-level scan of runtime named import
 * statements. `import type` clauses are erased at compile time and stay
 * legal. The scan covers the resolver top level only — files inside
 * `strategies/` import each other directly, which is legal within one
 * subdomain.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const RESOLVER_DIR = "src/core/domains/language/ruby/resolver";

/** Deep specifier prefixes a resolver top-level file must not runtime-import past. */
const BORDERS: readonly { barrel: string; deepPrefix: string }[] = [
  { barrel: "./strategies/index.js", deepPrefix: "./strategies/" },
  { barrel: "../../kernel/index.js", deepPrefix: "../../kernel/" },
  { barrel: "../dsl/index.js", deepPrefix: "../dsl/" },
];

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

function resolverFiles(): string[] {
  return readdirSync(join(ROOT, RESOLVER_DIR))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${RESOLVER_DIR}/${name}`);
}

describe("the ruby resolver imports its bordering subdomains through their barrels", () => {
  it("no resolver file runtime-imports a strategies/, kernel/ or dsl/ file past its barrel", () => {
    const offenders: string[] = [];
    for (const file of resolverFiles()) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        for (const border of BORDERS) {
          if (!statement.specifier.startsWith(border.deepPrefix)) continue;
          if (statement.specifier === border.barrel) continue;
          offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every border barrel exposes the runtime names the resolver consumes through it", () => {
    for (const file of resolverFiles()) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeImports(text)) {
        const border = BORDERS.find((entry) => statement.specifier === entry.barrel);
        if (!border) continue;
        const barrel = readFileSync(join(ROOT, RESOLVER_DIR, border.barrel).replace(/\.js$/, ".ts"), "utf-8");
        for (const name of statement.names) {
          expect(barrel, `${border.barrel} must re-export "${name}" for ${file}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
