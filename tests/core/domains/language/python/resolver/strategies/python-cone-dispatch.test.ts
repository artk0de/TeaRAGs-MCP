import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type HierarchyView,
  type InheritanceEdge,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../../src/core/domains/language/python/index.js";
import { PythonCallResolver } from "../../../../../../../src/core/domains/language/python/resolver/index.js";
import { MapHierarchyView } from "../../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import { buildHierarchySnapshot } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

/** Fake `HierarchyView` — only `getDescendants` is exercised by the cone. */
const hierarchyWith = (descendantsByAncestor: Record<string, string[]>): HierarchyView => ({
  getAncestors: () => [],
  getDescendants: (fqName: string): readonly InheritanceEdge[] =>
    (descendantsByAncestor[fqName] ?? []).map((sourceFqName) => ({
      sourceFqName,
      ancestorFqName: fqName,
      ancestorSymbolId: null,
      kind: "super",
      depth: 1,
    })),
});

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/caller.py",
  callerScope: [],
  imports: [],
  ...over,
});

// `pet.speak()` where `pet` is locally typed `Animal`, and Animal has subclasses
// Dog / Cat overriding `speak`. The cone fans `pet.speak` out to the overriding
// subclasses (CHA devirtualization, Python — bd tea-rags-mcp-f10y, N=2).
const call: CallRef = { callText: "pet.speak", receiver: "pet", member: "speak", startLine: 1 };

const animalBase: [string, NamedSymbol[]] = [
  "app/models/animal.py",
  [
    sym("Animal", "Animal", "app/models/animal.py", []),
    sym("Animal#speak", "speak", "app/models/animal.py", ["Animal"]),
  ],
];
const dog: [string, NamedSymbol[]] = [
  "app/animals/dog.py",
  [sym("Dog", "Dog", "app/animals/dog.py", []), sym("Dog#speak", "speak", "app/animals/dog.py", ["Dog"])],
];
const cat: [string, NamedSymbol[]] = [
  "app/animals/cat.py",
  [sym("Cat", "Cat", "app/animals/cat.py", []), sym("Cat#speak", "speak", "app/animals/cat.py", ["Cat"])],
];

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

// bd f2jsb: resolveDispatch now returns DispatchFanoutOutcome; existing
// assertions target the edges payload, so unwrap (throwing on `ambiguous`
// keeps the assertion strict — these fixtures never exceed the fan-out cap).
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

/**
 * The cone composed WITHOUT the untyped-name fan, which is on by default since
 * bd tea-rags-mcp-m99j1.1.57: this file measures the cone, and an untyped
 * receiver the cone declines is exactly what the fan would then claim.
 */
function coneOnlyResolver(): PythonCallResolver {
  const before = process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH;
  process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH = "0";
  try {
    return new PythonCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE);
  } finally {
    if (before === undefined) delete process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH;
    else process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH = before;
  }
}

describe("PythonCallResolver.resolveDispatch (CHA cone)", () => {
  const resolver = coneOnlyResolver();

  it("returns [] when the receiver is null (bare call never cones)", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = edgesOf(
      resolver.resolveDispatch(
        { callText: "speak", receiver: null, member: "speak", startLine: 1 },
        ctx({ symbolTable, hierarchy: hierarchyWith({ Animal: ["Dog"] }) }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the receiver has no local binding (external never cones)", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = edgesOf(
      resolver.resolveDispatch(call, ctx({ symbolTable, hierarchy: hierarchyWith({ Animal: ["Dog"] }) })),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when no hierarchy view is wired", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = edgesOf(
      resolver.resolveDispatch(call, ctx({ symbolTable, localBindings: { pet: [{ line: 1, type: "Animal" }] } })),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the bound type has no descendants (not polymorphic)", () => {
    const symbolTable = tableWith(animalBase);
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({ symbolTable, localBindings: { pet: [{ line: 1, type: "Animal" }] }, hierarchy: hierarchyWith({}) }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when descendants exist but none override the member", () => {
    // Dog declared but does NOT define `speak` → not in the cone.
    const symbolTable = tableWith(animalBase, ["app/animals/dog.py", [sym("Dog", "Dog", "app/animals/dog.py", [])]]);
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { pet: [{ line: 1, type: "Animal" }] },
          hierarchy: hierarchyWith({ Animal: ["Dog"] }),
        }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N overriding subtypes with confidence 1/N and edgeKind 'cone' (|cone| ≤ K)", () => {
    const symbolTable = tableWith(animalBase, dog, cat);
    const out = sortEdges(
      edgesOf(
        resolver.resolveDispatch(
          call,
          ctx({
            symbolTable,
            localBindings: { pet: [{ line: 1, type: "Animal" }] },
            hierarchy: hierarchyWith({ Animal: ["Dog", "Cat"] }),
          }),
        ),
      ),
    );
    expect(out).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/animals/cat.py",
        targetSymbolId: "Cat#speak",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "app/animals/dog.py",
        targetSymbolId: "Dog#speak",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("collapses to a single poly-base edge to the base decl when |cone| > K", () => {
    const symbolTable = tableWith(animalBase, dog, cat);
    // CODEGRAPH_PY_CONE_MAX=1 forces the >K branch with 2 overriding subtypes.
    const prev = process.env.CODEGRAPH_PY_CONE_MAX;
    process.env.CODEGRAPH_PY_CONE_MAX = "1";
    try {
      const out = edgesOf(
        new PythonCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE).resolveDispatch(
          call,
          ctx({
            symbolTable,
            localBindings: { pet: [{ line: 1, type: "Animal" }] },
            hierarchy: hierarchyWith({ Animal: ["Dog", "Cat"] }),
          }),
        ),
      );
      expect(out).toEqual([
        {
          sourceSymbolId: null,
          targetRelPath: "app/models/animal.py",
          targetSymbolId: "Animal#speak",
          edgeKind: "poly-base",
          confidence: 1,
        },
      ]);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_PY_CONE_MAX;
      else process.env.CODEGRAPH_PY_CONE_MAX = prev;
    }
  });
});

/**
 * bd tea-rags-mcp-39xca.14 — a receiver typed by a `typing.Protocol` reaches the
 * classes that satisfy it WITHOUT subclassing it: the Python language's deriver
 * adds their `structural` rows and the unchanged cone fans out over them.
 */
describe("PythonCallResolver.resolveDispatch — Protocol receiver, structural implementers (39xca.14)", () => {
  it("fans a Protocol-typed call out to every structural implementer", () => {
    const speaker: [string, NamedSymbol[]] = [
      "app/protocols.py",
      [
        sym("Speaker", "Speaker", "app/protocols.py", []),
        sym("Speaker#speak", "speak", "app/protocols.py", ["Speaker"]),
      ],
    ];
    const symbolTable = tableWith(speaker, dog, cat);
    const rows = new PythonLanguage().structuralConformance({
      contracts: [{ name: "Speaker", members: [{ name: "speak", params: 0 }] }],
      memberDefinitions: symbolTable.lookupByShortName("speak"),
      nominalRows: [],
    });
    const hierarchy = new MapHierarchyView(buildHierarchySnapshot(rows));

    const out = edgesOf(
      new PythonCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE).resolveDispatch(
        call,
        ctx({ symbolTable, localBindings: { pet: [{ line: 1, type: "Speaker" }] }, hierarchy }),
      ),
    );

    expect(sortEdges(out).map((edge) => [edge.targetSymbolId, edge.edgeKind, edge.confidence])).toEqual([
      ["Cat#speak", "cone", 0.5],
      ["Dog#speak", "cone", 0.5],
    ]);
  });
});
