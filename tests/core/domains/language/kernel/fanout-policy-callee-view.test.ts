/**
 * The dispatch fan-out distribution counts CALL TARGETS only
 * (bd tea-rags-mcp-jqvbn): an `interface` or a constant sharing a method's
 * short name widens no fan-out, so neither the corpus p99 nor a population's
 * may count one. Both read the same callee view of the symbol table.
 */
import { describe, expect, it } from "vitest";

import type { SymbolDefinition, SymbolDefinitionKind } from "../../../../../src/core/contracts/types/codegraph.js";
import type { DispatchFanoutPopulation } from "../../../../../src/core/contracts/types/language.js";
import {
  DISPATCH_FANOUT_POPULATION_MIN_MEMBERS,
  dispatchFanoutPolicyFor,
} from "../../../../../src/core/domains/language/kernel/fanout-policy.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const RUBY: DispatchFanoutPopulation = { family: "ruby", ownsPath: (p) => p.endsWith(".rb") };

const def = (relPath: string, name: string, symbolKind: SymbolDefinitionKind): SymbolDefinition => ({
  symbolId: `${relPath}#${name}`,
  fqName: `${relPath}#${name}`,
  shortName: name,
  relPath,
  scope: [],
  symbolKind,
});

/**
 * Every short name has exactly ONE method; the first 50 are also declared by 30
 * non-callable definitions each. Counted by kind-blind lookups, those names lift
 * the p99 to 31; counted as call targets, every name is a 1.
 */
function tableWithNonCallableNamesakes(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (let i = 0; i < DISPATCH_FANOUT_POPULATION_MIN_MEMBERS; i++) {
    table.upsertFile(`app/m${i}.rb`, [def(`app/m${i}.rb`, `name${i}`, "method")]);
  }
  for (let i = 0; i < 50; i++) {
    for (let j = 0; j < 30; j++) {
      table.upsertFile(`app/t${i}_${j}.rb`, [
        def(`app/t${i}_${j}.rb`, `name${i}`, j % 2 === 0 ? "constant" : "interface"),
      ]);
    }
  }
  return table;
}

describe("dispatch fan-out policy reads the callee view (bd tea-rags-mcp-jqvbn)", () => {
  it("keeps non-callable namesakes out of the corpus p99", () => {
    expect(dispatchFanoutPolicyFor(tableWithNonCallableNamesakes()).p99DefsPerMember).toBe(1);
  });

  it("keeps non-callable namesakes out of a population's p99", () => {
    expect(dispatchFanoutPolicyFor(tableWithNonCallableNamesakes(), { population: RUBY }).p99DefsPerMember).toBe(1);
  });
});
