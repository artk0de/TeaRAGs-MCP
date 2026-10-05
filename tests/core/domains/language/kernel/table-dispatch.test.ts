import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  DispatchRef,
  DispatchTableDef,
  DispatchTableEntry,
  SymbolResolutionTarget,
} from "../../../../../src/core/contracts/types/codegraph.js";
import {
  TableDispatchResolver,
  type TableDispatchPorts,
} from "../../../../../src/core/domains/language/kernel/table-dispatch.js";

/** The kernel reads nothing off the context itself — it only hands it to the ports. */
const ctx = {} as CallContext;

const TABLE_FILE = "app/handlers.rb";

const def: DispatchTableDef = {
  relPath: TABLE_FILE,
  table: { entries: { a: "OnA", b: "OnB", c: "OnC" } },
};

/**
 * Fake ports: one table named `HANDLERS`; a string entry `X` resolves to
 * `X#run` in the table file; anything else (unknown table, object entry,
 * names listed in `unresolvable`) is dropped.
 */
const portsWith = (unresolvable: readonly string[] = []): TableDispatchPorts => ({
  selectTableDef: (ref: DispatchRef): DispatchTableDef | null => (ref.table === "HANDLERS" ? def : null),
  resolveEntry: (entry: DispatchTableEntry): SymbolResolutionTarget | null =>
    typeof entry === "string" && !unresolvable.includes(entry)
      ? { targetRelPath: TABLE_FILE, targetSymbolId: `${entry}#run` }
      : null,
});

const dispatchCall = (dispatch: DispatchRef | undefined): CallRef => ({
  callText: "HANDLERS[k].run",
  receiver: null,
  member: "run",
  startLine: 1,
  dispatch,
});

const edgesOf = (outcome: DispatchFanoutOutcome) => (outcome.kind === "edges" ? outcome.edges : []);

describe("TableDispatchResolver", () => {
  it("narrows a literal key to ONE exact edge at confidence 1", () => {
    const outcome = new TableDispatchResolver(portsWith()).resolveDispatch(
      dispatchCall({ table: "HANDLERS", field: "run", key: "b" }),
      ctx,
    );

    expect(outcome).toEqual({
      kind: "edges",
      edges: [
        {
          sourceSymbolId: null,
          targetRelPath: TABLE_FILE,
          targetSymbolId: "OnB#run",
          edgeKind: "exact",
          confidence: 1,
        },
      ],
    });
  });

  it("fans a non-literal key over 3 entries to 3 registry edges at 1/3, in entry order", () => {
    const edges = edgesOf(
      new TableDispatchResolver(portsWith()).resolveDispatch(
        dispatchCall({ table: "HANDLERS", field: "run", key: null }),
        ctx,
      ),
    );

    expect(edges.map((e) => e.targetSymbolId)).toEqual(["OnA#run", "OnB#run", "OnC#run"]);
    for (const edge of edges) {
      expect(edge.edgeKind).toBe("registry");
      expect(edge.confidence).toBeCloseTo(1 / 3);
      expect(edge.sourceSymbolId).toBeNull();
    }
  });

  it("shares confidence over the RESOLVED entries only — an unresolvable entry is dropped, not counted", () => {
    const edges = edgesOf(
      new TableDispatchResolver(portsWith(["OnB"])).resolveDispatch(
        dispatchCall({ table: "HANDLERS", field: "run", key: null }),
        ctx,
      ),
    );

    expect(edges.map((e) => e.targetSymbolId)).toEqual(["OnA#run", "OnC#run"]);
    expect(edges.every((e) => e.confidence === 1 / 2)).toBe(true);
  });

  it("returns an empty outcome when no table is selected", () => {
    const outcome = new TableDispatchResolver(portsWith()).resolveDispatch(
      dispatchCall({ table: "OTHER", field: "run", key: null }),
      ctx,
    );

    expect(outcome).toEqual({ kind: "edges", edges: [] });
  });

  it("returns an empty outcome for a call without a dispatch reference", () => {
    expect(new TableDispatchResolver(portsWith()).resolveDispatch(dispatchCall(undefined), ctx)).toEqual({
      kind: "edges",
      edges: [],
    });
  });

  it("dedups entries resolving to the same target and stamps an explicit source on fanOut", () => {
    const ports: TableDispatchPorts = {
      selectTableDef: () => def,
      resolveEntry: () => ({ targetRelPath: TABLE_FILE, targetSymbolId: "Shared#run" }),
    };

    const edges = new TableDispatchResolver(ports).fanOut(
      { table: "HANDLERS", field: null, key: null },
      "Caller#invoke",
      dispatchCall(undefined),
      ctx,
    );

    expect(edges).toEqual([
      {
        sourceSymbolId: "Caller#invoke",
        targetRelPath: TABLE_FILE,
        targetSymbolId: "Shared#run",
        edgeKind: "registry",
        confidence: 1,
      },
    ]);
  });
});
