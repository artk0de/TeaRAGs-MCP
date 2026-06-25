import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { ResolverConfig } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { RubyUnionDispatchResolver } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-union-dispatch.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

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

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

// Shared symbol fixtures
const aFile: [string, NamedSymbol[]] = [
  "app/models/a.rb",
  [sym("A", "A", "app/models/a.rb", []), sym("A#process", "process", "app/models/a.rb", ["A"])],
];
const bFile: [string, NamedSymbol[]] = [
  "app/models/b.rb",
  [sym("B", "B", "app/models/b.rb", []), sym("B#process", "process", "app/models/b.rb", ["B"])],
];

// call with a union-typed local receiver `x` bound to [A, B]
const call: CallRef = { callText: "x.process", receiver: "x", member: "process", startLine: 5 };

describe("RubyUnionDispatchResolver (Task 1.7 — union receiver cone fan-out)", () => {
  const resolver = new RubyUnionDispatchResolver(cfg);

  it("returns [] when receiver is null (bare call — not union)", () => {
    const symbolTable = tableWith(aFile, bFile);
    const out = resolver.resolveDispatch(
      { callText: "process", receiver: null, member: "process", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when receiver has no local binding (untyped — union not available)", () => {
    const symbolTable = tableWith(aFile, bFile);
    const out = resolver.resolveDispatch(call, ctx({ symbolTable }));
    expect(out).toEqual([]);
  });

  it("returns [] when bound type is a plain instance (not a union)", () => {
    const symbolTable = tableWith(aFile);
    const out = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: { x: [{ line: 1, type: "A" }] },
      }),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N in-project cone edges when both union members declare the method", () => {
    const symbolTable = tableWith(aFile, bFile);
    const out = sortEdges(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: {
            x: [
              {
                line: 1,
                type: "A",
                typeRef: {
                  form: "union",
                  members: [
                    { form: "instance", name: "A" },
                    { form: "instance", name: "B" },
                  ],
                },
              },
            ],
          },
        }),
      ),
    );
    expect(out).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/models/a.rb",
        targetSymbolId: "A#process",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "app/models/b.rb",
        targetSymbolId: "B#process",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("filters external union members — only in-project members with known files emit edges", () => {
    const repoFile: [string, NamedSymbol[]] = [
      "app/repositories/repository.rb",
      [
        sym("Repository", "Repository", "app/repositories/repository.rb", []),
        sym("Repository#process", "process", "app/repositories/repository.rb", ["Repository"]),
      ],
    ];
    const symbolTable = tableWith(repoFile);
    const out = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: {
          x: [
            {
              line: 1,
              type: "Integer",
              typeRef: {
                form: "union",
                members: [
                  { form: "instance", name: "Integer" }, // external — no file in symbol table
                  { form: "instance", name: "Repository" }, // in-project
                ],
              },
            },
          ],
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      targetRelPath: "app/repositories/repository.rb",
      targetSymbolId: "Repository#process",
      edgeKind: "cone",
      confidence: 1,
    });
  });

  it("returns [] when no union member has the called method in-project", () => {
    const symbolTable = tableWith(aFile, bFile);
    const out = resolver.resolveDispatch(
      { callText: "x.unknown_method", receiver: "x", member: "unknown_method", startLine: 5 },
      ctx({
        symbolTable,
        localBindings: {
          x: [
            {
              line: 1,
              type: "A",
              typeRef: {
                form: "union",
                members: [
                  { form: "instance", name: "A" },
                  { form: "instance", name: "B" },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("collapses to [] when in-project targets exceed coneMax (no single base for a union)", () => {
    const symbolTable = tableWith(aFile, bFile);
    const out = new RubyUnionDispatchResolver({ ...cfg, coneMax: 1 }).resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: {
          x: [
            {
              line: 1,
              type: "A",
              typeRef: {
                form: "union",
                members: [
                  { form: "instance", name: "A" },
                  { form: "instance", name: "B" },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("deduplicates targets when the same symbolId appears via multiple union members", () => {
    const symbolTable = tableWith(aFile);
    const out = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: {
          x: [
            {
              line: 1,
              type: "A",
              typeRef: {
                form: "union",
                members: [
                  { form: "instance", name: "A" },
                  { form: "instance", name: "A" }, // duplicate
                ],
              },
            },
          ],
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].targetSymbolId).toBe("A#process");
    expect(out[0].confidence).toBeCloseTo(1, 10);
  });
});
