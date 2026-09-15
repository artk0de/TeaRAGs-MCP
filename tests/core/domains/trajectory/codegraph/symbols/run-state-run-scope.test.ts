/**
 * `CodegraphRunState.runScope` — the explicit identity of one resolve run (bd
 * tea-rags-mcp-39xca.6).
 *
 * Resolver memos used to infer "the run" from the identity of a long-lived
 * object: the `GlobalSymbolTable` (lives as long as the pool, bd 11qqk) or a
 * run-global channel such as `classAncestors` (reassigned at some seams, mutated
 * in place at others, bd z99hp). The token replaces that inference. It is minted
 * at the pass-1→pass-2 barrier and at every reset seam, and one token reaches
 * every `CallContext` built between two mints.
 */
import { describe, expect, it } from "vitest";

import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type { GlobalSymbolTable } from "../../../../../../src/core/contracts/types/codegraph.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

describe("CodegraphRunState.runScope", () => {
  it("exists before any seam fires and stays the same object until one does", () => {
    const state = new CodegraphRunState();
    const scope = state.runScope;

    expect(scope).toBeTypeOf("object");
    expect(state.runScope).toBe(scope);
  });

  it("is minted afresh at the pass-1→pass-2 barrier", async () => {
    const state = new CodegraphRunState();
    const before = state.runScope;

    await state.seal(noopTable);
    const sealed = state.runScope;

    expect(sealed).not.toBe(before);
    // Every CallContext of this pass-2 reads the same token.
    expect(state.runScope).toBe(sealed);

    await state.seal(noopTable);
    expect(state.runScope).not.toBe(sealed);
  });

  it("is minted afresh by clearForNextRun and by clearAll", () => {
    const state = new CodegraphRunState();
    const first = state.runScope;

    state.clearForNextRun();
    const second = state.runScope;
    expect(second).not.toBe(first);

    state.clearAll();
    expect(state.runScope).not.toBe(second);
  });

  it("is minted afresh on both branches of drainMetrics", () => {
    const state = new CodegraphRunState();
    const beforeEmpty = state.runScope;
    expect(state.drainMetrics()).toBeUndefined();
    const afterEmpty = state.runScope;
    expect(afterEmpty).not.toBe(beforeEmpty);

    state.stats.extractedFiles = 1;
    state.stats.fileEdgeCount = 1;
    expect(state.drainMetrics()).toBeDefined();
    expect(state.runScope).not.toBe(afterEmpty);
  });
});
