/**
 * Facade import-direction guard for the codegraph trajectory family factory
 * (bd tea-rags-mcp-0qaht.28).
 *
 * `codegraph/symbols/index.ts` is the symbols subdomain barrel. The L1 family
 * factory (`codegraph/factory.ts`) and the working-tree walk
 * (`working-tree/tree-graph-walk.ts`) sit outside `symbols/` and must reach it
 * through that barrel, not through `symbols/provider.js`,
 * `symbols/symbol-table.js`, `symbols/rerank/**` or `symbols/payload-signals.js`
 * (the leakingAbstraction BYPASS kind, same shape as git-facade-barrel.test.ts).
 *
 * Source-level scan of every import/export-from specifier, type-only ones
 * included: a type edge past the barrel couples the same way.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BARREL = "src/core/domains/trajectory/codegraph/symbols/index.ts";

/** Consumers outside `symbols/`, with the specifier prefix that reaches the symbols subdomain. */
const CONSUMERS: { file: string; symbolsPrefix: string }[] = [
  { file: "src/core/domains/trajectory/codegraph/factory.ts", symbolsPrefix: "./symbols/" },
  { file: "src/core/domains/trajectory/codegraph/working-tree/tree-graph-walk.ts", symbolsPrefix: "../symbols/" },
];

interface Statement {
  names: string[];
  specifier: string;
}

function statements(text: string): Statement[] {
  const out: Statement[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const names = match[1]
      .split(",")
      .map((clause) => clause.trim().replace(/^type\s+/, ""))
      .filter((clause) => clause.length > 0);
    out.push({ names, specifier: match[2] });
  }
  return out;
}

describe("codegraph consumers import the symbols subdomain through its barrel", () => {
  it("no consumer reaches past symbols/index.js", () => {
    const offenders: string[] = [];
    for (const { file, symbolsPrefix } of CONSUMERS) {
      for (const statement of statements(readFileSync(join(ROOT, file), "utf-8"))) {
        if (!statement.specifier.startsWith(symbolsPrefix)) continue;
        if (statement.specifier === `${symbolsPrefix}index.js`) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the symbols barrel exposes the names the consumers take through it", () => {
    const barrel = readFileSync(join(ROOT, BARREL), "utf-8");
    for (const { file, symbolsPrefix } of CONSUMERS) {
      for (const statement of statements(readFileSync(join(ROOT, file), "utf-8"))) {
        if (statement.specifier !== `${symbolsPrefix}index.js`) continue;
        for (const name of statement.names) {
          expect(barrel, `${BARREL} must export "${name}" for ${file}`).toMatch(new RegExp(`\\b${name}\\b`));
        }
      }
    }
  });
});
