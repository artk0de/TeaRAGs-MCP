/**
 * bd tea-rags-mcp-39xca.14 — structural implementers become CHA cone members.
 *
 * The barrier matches every structural contract of a family against the
 * project-wide symbol table and adds a derived `structural` row for each owner
 * that conforms without declaring it. The rows reach the family's hierarchy view
 * (so `getDescendants(Interface)` names the implementer) and nothing else: they
 * are not accumulated as inheritance rows, so pass-2 never persists them, and an
 * MRO walk restricted to nominal kinds never sees them.
 */
import { describe, expect, it } from "vitest";

import {
  NOMINAL_INHERITANCE_KINDS,
  type CodegraphPass1FileAggregates,
  type FileExtraction,
  type GlobalSymbolTable,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { StructuralConformanceDeriver } from "../../../../../../src/core/contracts/types/language.js";
import { deriveStructuralConformance } from "../../../../../../src/core/domains/language/kernel/structural-conformance.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function file(relPath: string, language: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return { relPath, language, imports: [], fileScope: [], chunks: [], ...extra };
}

function method(relPath: string, owner: string, name: string): SymbolDefinition {
  return {
    symbolId: `${owner}#${name}`,
    fqName: `${owner}#${name}`,
    shortName: name,
    relPath,
    scope: [owner],
    symbolKind: "method",
  };
}

/** A table holding `MapRegistry#find` (TS), `PyRegistry#find` (Python) and a Ruby namesake. */
function symbolTable(): GlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/map-registry.ts", [method("src/map-registry.ts", "MapRegistry", "find")]);
  table.upsertFile("app/py_registry.py", [method("app/py_registry.py", "PyRegistry", "find")]);
  table.upsertFile("app/rb_registry.rb", [method("app/rb_registry.rb", "RbRegistry", "find")]);
  return table;
}

const registryContract = { name: "Registry", members: [{ name: "find", params: 1 }] };

/** Each language's deriver keeps its own files, as the language facades do. */
function derivers(): Map<string, StructuralConformanceDeriver> {
  const ownedBy =
    (extension: string): StructuralConformanceDeriver =>
    (input) =>
      deriveStructuralConformance(input, (relPath) => relPath.endsWith(extension));
  return new Map([
    ["typescript", ownedBy(".ts")],
    ["python", ownedBy(".py")],
  ]);
}

describe("CodegraphRunState — structural conformance at the barrier (39xca.14)", () => {
  it("adds the structural implementer to the family's hierarchy view", async () => {
    const state = new CodegraphRunState([], [], derivers());
    state.absorb(file("src/registry.ts", "typescript", { structuralContracts: [registryContract] }), []);
    await state.seal(async () => symbolTable());

    const view = state.hierarchyViewFor("typescript");
    expect(view?.getDescendants("Registry").map((e) => [e.sourceFqName, e.kind])).toEqual([
      ["MapRegistry", "structural"],
    ]);
  });

  // bd tea-rags-mcp-39xca.19 — the barrier hands the deriver the definitions
  // naming each member's owner, so an object-literal declarator (walker kind
  // `module`) conforms through its `.` member.
  it("threads the owners' definitions, so an object-literal declarator conforms", async () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/policy.ts", [
      {
        symbolId: "POLICY",
        fqName: "POLICY",
        shortName: "POLICY",
        relPath: "src/policy.ts",
        scope: [],
        symbolKind: "module",
      },
      {
        symbolId: "POLICY.find",
        fqName: "POLICY.find",
        shortName: "find",
        relPath: "src/policy.ts",
        scope: ["POLICY"],
      },
    ]);
    const state = new CodegraphRunState([], [], derivers());
    state.absorb(file("src/registry.ts", "typescript", { structuralContracts: [registryContract] }), []);
    await state.seal(async () => table);

    expect(
      state
        .hierarchyViewFor("typescript")
        ?.getDescendants("Registry")
        .map((e) => e.sourceFqName),
    ).toEqual(["POLICY"]);
  });

  it("keeps the rows out of the persisted inheritance rows and out of a nominal-kinds walk", async () => {
    const state = new CodegraphRunState([], [], derivers());
    state.absorb(file("src/registry.ts", "typescript", { structuralContracts: [registryContract] }), []);
    await state.seal(async () => symbolTable());

    expect(state.inheritanceRows).toEqual([]);
    expect(
      state.hierarchyViewFor("typescript")?.getAncestors("MapRegistry", { kinds: NOMINAL_INHERITANCE_KINDS }),
    ).toEqual([]);
  });

  it("derives per family: a Python Protocol reaches the Python owner, never the TypeScript or Ruby one", async () => {
    const state = new CodegraphRunState([], [], derivers());
    state.absorb(file("app/protocols.py", "python", { structuralContracts: [registryContract] }), []);
    await state.seal(async () => symbolTable());

    expect(
      state
        .hierarchyViewFor("python")
        ?.getDescendants("Registry")
        .map((e) => e.sourceFqName),
    ).toEqual(["PyRegistry"]);
    expect(state.hierarchyViewFor("typescript")?.getDescendants("Registry")).toEqual([]);
  });

  it("derives nothing for a family whose language offers no deriver", async () => {
    const state = new CodegraphRunState();
    state.absorb(file("src/registry.ts", "typescript", { structuralContracts: [registryContract] }), []);
    await state.seal(async () => symbolTable());

    expect(state.hierarchyViewFor("typescript")?.getDescendants("Registry")).toEqual([]);
  });

  it("hydrates an unwalked file's contracts, and a re-walk that drops them wins", async () => {
    const slices: CodegraphPass1FileAggregates[] = [
      { relPath: "src/registry.ts", language: "typescript", structuralContracts: [registryContract] },
      {
        relPath: "src/gone.ts",
        language: "typescript",
        structuralContracts: [{ name: "Gone", members: [{ name: "find", params: 0 }] }],
      },
    ];
    const state = new CodegraphRunState([], [], derivers());
    // `src/gone.ts` is walked this run and no longer declares its contract.
    state.absorb(file("src/gone.ts", "typescript"), []);
    await state.seal(
      async () => symbolTable(),
      async () => slices,
    );

    const view = state.hierarchyViewFor("typescript");
    expect(view?.getDescendants("Registry").map((e) => e.sourceFqName)).toEqual(["MapRegistry"]);
    expect(view?.getDescendants("Gone")).toEqual([]);
    expect(state.structuralContracts["src/registry.ts"]?.contracts).toEqual([registryContract]);
  });
});
