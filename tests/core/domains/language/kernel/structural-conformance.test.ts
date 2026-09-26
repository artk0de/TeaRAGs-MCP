import { describe, expect, it } from "vitest";

import type {
  AritySignature,
  InheritanceEdgeRow,
  StructuralContractDecl,
  SymbolDefinition,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { deriveStructuralConformance } from "../../../../../src/core/domains/language/kernel/structural-conformance.js";

/** A method `owner#name`, optionally with a recorded positional arity. */
const method = (owner: string, name: string, arity?: [number, number, boolean?]): SymbolDefinition => {
  const signature: AritySignature | undefined =
    arity === undefined ? undefined : { minRequired: arity[0], maxPositional: arity[1], hasSplat: arity[2] ?? false };
  return {
    symbolId: `${owner}#${name}`,
    fqName: `${owner}#${name}`,
    shortName: name,
    relPath: `src/${owner}.ts`,
    scope: [owner],
    symbolKind: "method",
    ...(signature === undefined ? {} : { arity: signature }),
  };
};

const contract = (name: string, ...members: [string, number][]): StructuralContractDecl => ({
  name,
  members: members.map(([memberName, params]) => ({ name: memberName, params })),
});

const nominal = (source: string, ancestor: string, kind: InheritanceEdgeRow["kind"] = "super"): InheritanceEdgeRow => ({
  sourceFqName: source,
  sourceSymbolId: null,
  ancestorFqName: ancestor,
  ancestorSymbolId: null,
  kind,
  ordinal: 0,
});

/** The derived relation as `owner -> contract` pairs. */
const pairs = (rows: readonly InheritanceEdgeRow[]): string[] =>
  rows.map((row) => `${row.sourceFqName} -> ${row.ancestorFqName}`);

describe("deriveStructuralConformance", () => {
  it("adds a structural row for an owner carrying every required member", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Registry", ["find", 1], ["list", 0])],
      memberDefinitions: [method("MapRegistry", "find"), method("MapRegistry", "list"), method("Other", "find")],
      nominalRows: [],
    });

    expect(rows).toEqual([
      {
        sourceFqName: "MapRegistry",
        sourceSymbolId: null,
        ancestorFqName: "Registry",
        ancestorSymbolId: null,
        kind: "structural",
        ordinal: 0,
      },
    ]);
  });

  it("accepts an implementation requiring fewer parameters and rejects one requiring more", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Store", ["put", 2])],
      memberDefinitions: [
        method("Loose", "put", [1, 1]),
        method("Exact", "put", [2, 2]),
        method("Strict", "put", [3, 3]),
        method("Unknown", "put"),
      ],
      nominalRows: [],
    });

    expect(pairs(rows)).toEqual(["Exact -> Store", "Loose -> Store", "Unknown -> Store"]);
  });

  it("requires the members a contract inherits through its nominal heritage", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Base", ["open", 0]), contract("Derived", ["read", 0])],
      memberDefinitions: [method("Full", "open"), method("Full", "read"), method("Half", "read")],
      nominalRows: [nominal("Derived", "Base", "implements")],
    });

    expect(pairs(rows)).toEqual(["Full -> Base", "Full -> Derived"]);
  });

  it("counts members an owner inherits from its nominal ancestors", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Closeable", ["open", 0], ["close", 0])],
      memberDefinitions: [method("Parent", "open"), method("Child", "close")],
      nominalRows: [nominal("Child", "Parent")],
    });

    expect(pairs(rows)).toEqual(["Child -> Closeable"]);
  });

  it("never lists a contract, an existing nominal descendant, or a contract with no members", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Runner", ["run", 0]), contract("Twin", ["run", 0]), contract("Empty")],
      memberDefinitions: [method("Twin", "run"), method("Declared", "run"), method("Free", "run")],
      nominalRows: [nominal("Declared", "Runner", "implements")],
    });

    expect(pairs(rows)).toEqual(["Free -> Runner", "Declared -> Twin", "Free -> Twin"]);
  });

  it("reads the owner off the innermost scope segment and skips definitions with no owner or a type kind", () => {
    const factoryMember: SymbolDefinition = {
      symbolId: "createOutcome.isFullSuccess",
      fqName: "createOutcome.isFullSuccess",
      shortName: "isFullSuccess",
      relPath: "src/outcome.ts",
      scope: ["createOutcome"],
    };
    const topLevel: SymbolDefinition = { ...factoryMember, symbolId: "isFullSuccess", scope: [] };
    const nestedType: SymbolDefinition = {
      ...factoryMember,
      symbolId: "Holder.isFullSuccess",
      scope: ["Holder"],
      symbolKind: "class",
    };

    const rows = deriveStructuralConformance({
      contracts: [contract("Outcome", ["isFullSuccess", 0])],
      memberDefinitions: [factoryMember, topLevel, nestedType],
      nominalRows: [],
    });

    expect(pairs(rows)).toEqual(["createOutcome -> Outcome"]);
  });

  it("returns rows sorted by contract then owner whatever the input order", () => {
    const input = {
      contracts: [contract("Zed", ["go", 0]), contract("Alpha", ["go", 0])],
      memberDefinitions: [method("Owner2", "go"), method("Owner1", "go")],
      nominalRows: [],
    };
    const reversed = {
      ...input,
      contracts: [...input.contracts].reverse(),
      memberDefinitions: [...input.memberDefinitions].reverse(),
    };

    expect(pairs(deriveStructuralConformance(input))).toEqual([
      "Owner1 -> Alpha",
      "Owner2 -> Alpha",
      "Owner1 -> Zed",
      "Owner2 -> Zed",
    ]);
    expect(deriveStructuralConformance(reversed)).toEqual(deriveStructuralConformance(input));
  });

  it("never lets a nested contract, named by its qualified path, conform to itself", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Outer.Speaker", ["speak", 0])],
      memberDefinitions: [method("Speaker", "speak"), method("Dog", "speak")],
      nominalRows: [],
    });

    expect(pairs(rows)).toEqual(["Dog -> Outer.Speaker"]);
  });

  it("considers only the definitions the calling language owns", () => {
    const rubyNamesake: SymbolDefinition = { ...method("RubyOwner", "find"), relPath: "app/ruby_owner.rb" };
    const rows = deriveStructuralConformance(
      {
        contracts: [contract("Finder", ["find", 0])],
        memberDefinitions: [method("TsOwner", "find"), rubyNamesake],
        nominalRows: [],
      },
      (relPath) => relPath.endsWith(".ts"),
    );

    expect(pairs(rows)).toEqual(["TsOwner -> Finder"]);
  });

  it("lets an owner conform to any one of several same-named contract declarations", () => {
    const rows = deriveStructuralConformance({
      contracts: [contract("Options", ["a", 0]), contract("Options", ["b", 0])],
      memberDefinitions: [method("OnlyB", "b")],
      nominalRows: [],
    });

    expect(pairs(rows)).toEqual(["OnlyB -> Options"]);
  });
});
