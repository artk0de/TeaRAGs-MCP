/**
 * `PythonCallResolver`'s dispatch stack, composed exactly as production
 * composes it (bd tea-rags-mcp-w205u, E4.1.3).
 *
 * `CallEdgeResolutionRunner` asks `resolveDispatch` BEFORE `resolve` and lets a
 * non-empty fan-out REPLACE the chain's answer (`resolution-runner.ts:557`), so
 * the property that has to hold at this level is the one the offline columns
 * call `exactReplacedByFan`: a site the exact chain answers must reach the
 * runner with no fan at all.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const defsOf = (relPath: string, symbolIds: string[]): SymbolDefinition[] =>
  symbolIds.map((symbolId) => ({
    symbolId,
    fqName: symbolId,
    shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
    relPath,
    scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
  }));

const tableWith = (files: Record<string, string[]>): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) table.upsertFile(relPath, defsOf(relPath, symbolIds));
  return table;
};

const ctxOf = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "app/handlers.py",
  callerScope: ["Handler"],
  imports: [],
  symbolTable,
  classAncestors: {},
});

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

const FLAG = "CODEGRAPH_PY_DYNAMIC_DISPATCH";

/** A resolver composed with the flag in `value`, read once in its constructor. */
const resolverWith = (value: string | undefined): PythonCallResolver => {
  const before = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return new PythonCallResolver();
  } finally {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  }
};

describe("PythonCallResolver.resolveDispatch (w205u — [cone] by default, [cone, dynamic] under the flag)", () => {
  it("composes the CONE ALONE by default — the untyped-name fan is parked (D10)", () => {
    const table = tableWith({
      "app/models/mirror.py": ["Mirror", "Mirror#perform"],
      "app/models/replica.py": ["Replica", "Replica#perform"],
      "app/handlers.py": ["Handler", "Handler#run"],
    });
    const ctx = ctxOf(table);
    const site = call("thing", "perform");

    expect(resolverWith(undefined).resolveDispatch(site, ctx)).toEqual({ kind: "edges", edges: [] });
    expect(resolverWith("0").resolveDispatch(site, ctx)).toEqual({ kind: "edges", edges: [] });
  });

  it("never replaces an exact chain answer with a fan", () => {
    const table = tableWith({
      "app/models/data_source.py": ["DataSource", "DataSource#perform"],
      "app/models/mirror.py": ["Mirror", "Mirror#perform"],
      "app/models/replica.py": ["Replica", "Replica#perform"],
      "app/handlers.py": ["Handler", "Handler#run"],
    });
    const resolver = resolverWith("1");
    const ctx = ctxOf(table);
    const site = call("data_source", "perform");

    expect(resolver.resolve(site, ctx)).toEqual({
      targetRelPath: "app/models/data_source.py",
      targetSymbolId: "DataSource#perform",
    });
    expect(resolver.resolveDispatch(site, ctx)).toEqual({ kind: "edges", edges: [] });
  });

  it("declines a typeshed member under the flag, and leaves the chain's typed answer alone (w205u.14)", () => {
    const table = tableWith({
      "app/models/data_source.py": ["DataSource", "DataSource#sync"],
      "app/models/mirror.py": ["Mirror", "Mirror#sync"],
      "app/models/replica.py": ["Replica", "Replica#sync"],
    });
    const resolver = resolverWith("1");
    const ctx = ctxOf(table);

    expect(resolver.resolveDispatch(call("thing", "sync"), ctx)).toEqual({ kind: "edges", edges: [] });
    expect(resolver.resolve(call("data_source", "sync"), ctx)).toEqual({
      targetRelPath: "app/models/data_source.py",
      targetSymbolId: "DataSource#sync",
    });
  });

  it("fans an untyped name the chain does not answer over the member's owners, under the flag", () => {
    const table = tableWith({
      "app/models/mirror.py": ["Mirror", "Mirror#perform"],
      "app/models/replica.py": ["Replica", "Replica#perform"],
      "app/handlers.py": ["Handler", "Handler#run"],
    });
    const resolver = resolverWith("1");
    const ctx = ctxOf(table);
    const site = call("thing", "perform");

    expect(resolver.resolve(site, ctx)).toBeNull();
    const outcome = resolver.resolveDispatch(site, ctx);
    if (outcome.kind !== "edges") throw new Error(`expected edges, got ${outcome.kind}`);
    expect(outcome.edges.map((e) => e.targetSymbolId)).toEqual(["Mirror#perform", "Replica#perform"]);
    expect(outcome.edges.every((e) => e.edgeKind === "dynamic")).toBe(true);
  });
});
