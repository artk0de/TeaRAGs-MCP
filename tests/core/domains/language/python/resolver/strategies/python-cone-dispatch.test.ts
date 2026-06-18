import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type HierarchyView,
  type InheritanceEdge,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../../src/core/domains/language/python/resolver/index.js";
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

describe("PythonCallResolver.resolveDispatch (CHA cone)", () => {
  const resolver = new PythonCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE);

  it("returns [] when the receiver is null (bare call never cones)", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = resolver.resolveDispatch(
      { callText: "speak", receiver: null, member: "speak", startLine: 1 },
      ctx({ symbolTable, hierarchy: hierarchyWith({ Animal: ["Dog"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the receiver has no local binding (external never cones)", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = resolver.resolveDispatch(call, ctx({ symbolTable, hierarchy: hierarchyWith({ Animal: ["Dog"] }) }));
    expect(out).toEqual([]);
  });

  it("returns [] when no hierarchy view is wired", () => {
    const symbolTable = tableWith(animalBase, dog);
    const out = resolver.resolveDispatch(call, ctx({ symbolTable, localBindings: { pet: "Animal" } }));
    expect(out).toEqual([]);
  });

  it("returns [] when the bound type has no descendants (not polymorphic)", () => {
    const symbolTable = tableWith(animalBase);
    const out = resolver.resolveDispatch(
      call,
      ctx({ symbolTable, localBindings: { pet: "Animal" }, hierarchy: hierarchyWith({}) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when descendants exist but none override the member", () => {
    // Dog declared but does NOT define `speak` → not in the cone.
    const symbolTable = tableWith(animalBase, ["app/animals/dog.py", [sym("Dog", "Dog", "app/animals/dog.py", [])]]);
    const out = resolver.resolveDispatch(
      call,
      ctx({ symbolTable, localBindings: { pet: "Animal" }, hierarchy: hierarchyWith({ Animal: ["Dog"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N overriding subtypes with confidence 1/N and edgeKind 'cone' (|cone| ≤ K)", () => {
    const symbolTable = tableWith(animalBase, dog, cat);
    const out = sortEdges(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { pet: "Animal" },
          hierarchy: hierarchyWith({ Animal: ["Dog", "Cat"] }),
        }),
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
      const out = new PythonCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE).resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { pet: "Animal" },
          hierarchy: hierarchyWith({ Animal: ["Dog", "Cat"] }),
        }),
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
