/**
 * trace_path endpoints alias a host-class id onto the member's definer (bd
 * tea-rags-mcp-u0t4p, reusing the 63l69 policy `resolveInheritedMemberDefiner`).
 *
 * `Account#suspend!` has no node of its own when an included concern defines
 * it; a `from` / `to` naming the host must seed / terminate at the definer, the
 * same answer `get_callers` / `get_callees` give. An id with its own node is
 * never aliased, and the response names the definer that was traced.
 */
import { describe, expect, it, vi } from "vitest";

import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import {
  fileScopedSymbolKey,
  type InheritanceEdge,
  type SymbolVisibilityRow,
} from "../../../../../src/core/contracts/types/codegraph.js";

// Controller#update -> Account::Suspensions#suspend! -> Mailer#notify
// Account includes Account::Suspensions (ordinal 0) and Account::Silences (ordinal 1);
// only Suspensions defines `suspend!`.
const FILES: Record<string, string> = {
  "Controller#update": "controller.rb",
  "Account::Suspensions#suspend!": "suspensions.rb",
  "Mailer#notify": "mailer.rb",
  "Account#own": "account.rb",
};
const ADJACENCY: Record<string, string[]> = {
  "Controller#update": ["Account::Suspensions#suspend!"],
  "Account::Suspensions#suspend!": ["Mailer#notify"],
};
const SUPERTYPES: Record<string, InheritanceEdge[]> = {
  Account: [
    {
      sourceFqName: "Account",
      ancestorFqName: "Account::Suspensions",
      ancestorSymbolId: null,
      kind: "include",
      depth: 1,
      ordinal: 0,
    },
    {
      sourceFqName: "Account",
      ancestorFqName: "Account::Silences",
      ancestorSymbolId: null,
      kind: "include",
      depth: 1,
      ordinal: 1,
    },
  ],
};

function makeOps() {
  const graphDb = {
    getSymbolRelPaths: vi.fn(
      async (ids: string[]) => new Map(ids.filter((id) => FILES[id]).map((id) => [id, [FILES[id]]])),
    ),
    getCalleeEdgesScoped: vi.fn(async (refs: { relPath: string; symbolId: string }[]) => {
      const out = new Map<string, { relPath: string; symbolId: string }[]>();
      for (const ref of refs) {
        const targets = ADJACENCY[ref.symbolId];
        if (targets) {
          out.set(
            fileScopedSymbolKey(ref),
            targets.map((s) => ({ relPath: FILES[s], symbolId: s })),
          );
        }
      }
      return out;
    }),
    getSupertypes: vi.fn(async (fqName: string) => SUPERTYPES[fqName] ?? []),
    getSymbolVisibilities: vi.fn(
      async (ids: readonly string[]): Promise<SymbolVisibilityRow[]> =>
        ids.filter((id) => FILES[id]).map((id) => ({ relPath: FILES[id], symbolId: id, visibility: null })),
    ),
    close: vi.fn(async () => undefined),
  };
  const ops = new TracePathOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    qdrant: { scrollBySymbolIds: vi.fn(async () => []) } as never,
    reranker: {} as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n,
  });
  return { ops, graphDb };
}

describe("TracePathOps — host-class endpoint aliasing (bd tea-rags-mcp-u0t4p)", () => {
  it("a host-class `to` terminates at the member's definer", async () => {
    const { ops } = makeOps();

    const res = await ops.tracePath({ collection: "c", from: "Controller#update", to: "Account#suspend!" });

    expect(res.paths.map((p) => p.steps.map((s) => s.symbolId))).toEqual([
      ["Controller#update", "Account::Suspensions#suspend!"],
    ]);
    expect(res.resolvedEndpoints).toEqual({ to: "Account::Suspensions#suspend!" });
  });

  it("a host-class `from` seeds at the member's definer", async () => {
    const { ops } = makeOps();

    const res = await ops.tracePath({ collection: "c", from: "Account#suspend!", to: "Mailer#notify" });

    expect(res.paths.map((p) => p.steps.map((s) => s.symbolId))).toEqual([
      ["Account::Suspensions#suspend!", "Mailer#notify"],
    ]);
    expect(res.resolvedEndpoints).toEqual({ from: "Account::Suspensions#suspend!" });
  });

  it("never aliases an endpoint that has its own node, and omits `resolvedEndpoints`", async () => {
    const { ops, graphDb } = makeOps();

    const res = await ops.tracePath({ collection: "c", from: "Controller#update", to: "Mailer#notify" });

    expect(res.paths).toHaveLength(1);
    expect(res.resolvedEndpoints).toBeUndefined();
    expect(graphDb.getSupertypes).not.toHaveBeenCalled();
  });

  it("an unknown member with no definer stays unresolved (empty trace, no alias)", async () => {
    const { ops } = makeOps();

    const res = await ops.tracePath({ collection: "c", from: "Controller#update", to: "Account#missing" });

    expect(res.paths).toEqual([]);
    expect(res.resolvedEndpoints).toBeUndefined();
  });

  it("a failing hierarchy read leaves the endpoint unaliased", async () => {
    const { ops, graphDb } = makeOps();
    graphDb.getSupertypes.mockRejectedValueOnce(new Error("boom"));

    const res = await ops.tracePath({ collection: "c", from: "Controller#update", to: "Account#suspend!" });

    expect(res.paths).toEqual([]);
    expect(res.resolvedEndpoints).toBeUndefined();
  });
});
