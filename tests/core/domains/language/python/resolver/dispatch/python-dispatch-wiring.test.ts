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

describe("PythonCallResolver.resolveDispatch (w205u — [cone, dynamic])", () => {
  it("never replaces an exact chain answer with a fan", () => {
    const table = tableWith({
      "app/models/data_source.py": ["DataSource", "DataSource#sync"],
      "app/models/mirror.py": ["Mirror", "Mirror#sync"],
      "app/models/replica.py": ["Replica", "Replica#sync"],
      "app/handlers.py": ["Handler", "Handler#run"],
    });
    const resolver = new PythonCallResolver();
    const ctx = ctxOf(table);
    const site = call("data_source", "sync");

    expect(resolver.resolve(site, ctx)).toEqual({
      targetRelPath: "app/models/data_source.py",
      targetSymbolId: "DataSource#sync",
    });
    expect(resolver.resolveDispatch(site, ctx)).toEqual({ kind: "edges", edges: [] });
  });

  it("fans an untyped name the chain does not answer over the member's owners", () => {
    const table = tableWith({
      "app/models/mirror.py": ["Mirror", "Mirror#sync"],
      "app/models/replica.py": ["Replica", "Replica#sync"],
      "app/handlers.py": ["Handler", "Handler#run"],
    });
    const resolver = new PythonCallResolver();
    const ctx = ctxOf(table);
    const site = call("thing", "sync");

    expect(resolver.resolve(site, ctx)).toBeNull();
    const outcome = resolver.resolveDispatch(site, ctx);
    if (outcome.kind !== "edges") throw new Error(`expected edges, got ${outcome.kind}`);
    expect(outcome.edges.map((e) => e.targetSymbolId)).toEqual(["Mirror#sync", "Replica#sync"]);
    expect(outcome.edges.every((e) => e.edgeKind === "dynamic")).toBe(true);
  });
});
