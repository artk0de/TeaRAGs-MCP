/**
 * SymbolNodeFlushQueue (bd tea-rags-mcp-6vfrj / G2) — durable batched
 * `cg_symbols` node-write chain hoisted out of the post-embedding finalize
 * tail. Fire-and-chain buffering with a latched-error drain: every chain
 * link resolves (errors latch rather than reject the tail) so the
 * fire-and-chain window never trips Node's unhandled-rejection process kill,
 * and `flushRemainder` rethrows the latched error once the whole chain
 * settles — aborting the run cleanly before pass-2 (nodes-before-edges).
 */

import { describe, expect, it } from "vitest";

import type {
  BulkSymbolUpsertEntry,
  GraphDbClient,
  IdentifierReplaceEntry,
  TypeDeclarationReplaceEntry,
  TypeDeclarationRow,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  SymbolNodeFlushQueue,
  type GraphDbResolver,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/node-flush.js";

function makeResolver(graphDb: Partial<GraphDbClient>): GraphDbResolver {
  return async () => ({ graphDb: graphDb as GraphDbClient });
}

describe("SymbolNodeFlushQueue", () => {
  it("flushRemainder resolves cleanly for a collection key that never buffered anything", async () => {
    let calls = 0;
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => {
          calls += 1;
        },
      }),
      256,
    );

    await expect(queue.flushRemainder("never-buffered")).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("reset(key) drops only that collection's buffered state, leaving another collection's buffer intact", async () => {
    const flushedBatches: BulkSymbolUpsertEntry[][] = [];
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async (entries: BulkSymbolUpsertEntry[]) => {
          flushedBatches.push(entries);
        },
      }),
      // Cadence high enough that buffer() below never auto-flushes; only an
      // explicit flushRemainder drains it.
      1000,
    );
    queue.buffer("src/a.ts", [], "collA");
    queue.buffer("src/b.ts", [], "collB");

    queue.reset("collA");

    await queue.flushRemainder("collA");
    await queue.flushRemainder("collB");

    // collA's buffer was dropped by reset() before it ever flushed; collB's
    // survives untouched and flushes its one buffered file.
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]?.[0]?.relPath).toBe("src/b.ts");
  });

  it("latches the first eager-flush error and rethrows it from flushRemainder after draining the whole chain", async () => {
    const failure = new Error("duckdb write denied");
    let calls = 0;
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => {
          calls += 1;
          throw failure;
        },
      }),
      // Cadence of 1 — buffer() itself chains the flush immediately.
      1,
    );
    queue.buffer("src/a.ts", [], "coll");

    await expect(queue.flushRemainder("coll")).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

// bd tea-rags-mcp-4p3sb.9 — the same flush carries each file's identifier rows
// into `cg_identifiers`, after its symbols.
describe("SymbolNodeFlushQueue — identifier rows", () => {
  it("hands buffered identifiers to replaceIdentifiersBulk with their relPath, after upsertSymbolsBulk", async () => {
    const order: string[] = [];
    const replaced: IdentifierReplaceEntry[][] = [];
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => {
          order.push("symbols");
        },
        replaceIdentifiersBulk: async (entries: readonly IdentifierReplaceEntry[]) => {
          order.push("identifiers");
          replaced.push([...entries]);
        },
      }),
      1000,
    );
    const row = { ownerSymbolId: "A#run", kind: "local" as const, name: "doc", line: 3 };
    queue.buffer("src/a.rb", [], "coll", undefined, [row]);
    queue.buffer("src/b.rb", [], "coll", undefined, []);

    await queue.flushRemainder("coll");

    expect(order).toEqual(["symbols", "identifiers"]);
    // A file buffered with [] still produces an entry — that is what clears it.
    expect(replaced).toEqual([
      [
        { relPath: "src/a.rb", rows: [row] },
        { relPath: "src/b.rb", rows: [] },
      ],
    ]);
  });

  it("does not write identifiers for files buffered without any", async () => {
    let identifierCalls = 0;
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => undefined,
        replaceIdentifiersBulk: async () => {
          identifierCalls += 1;
        },
      }),
      1000,
    );
    queue.buffer("src/a.rb", [], "coll");

    await queue.flushRemainder("coll");

    expect(identifierCalls).toBe(0);
  });
});

// bd tea-rags-mcp-vi0wx — and each file's type-declaration rows into
// `cg_type_declarations`, after its identifiers, with the same clear-on-[] rule.
describe("SymbolNodeFlushQueue — type-declaration rows", () => {
  const row: TypeDeclarationRow = {
    language: "swift",
    typeId: "A",
    shortName: "A",
    symbolKind: "class",
    line: 1,
    reopens: false,
    supertypes: [],
  };

  it("hands buffered type declarations to replaceTypeDeclarationsBulk after the identifiers", async () => {
    const order: string[] = [];
    const replaced: TypeDeclarationReplaceEntry[][] = [];
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => {
          order.push("symbols");
        },
        replaceIdentifiersBulk: async () => {
          order.push("identifiers");
        },
        replaceTypeDeclarationsBulk: async (entries: readonly TypeDeclarationReplaceEntry[]) => {
          order.push("typeDeclarations");
          replaced.push([...entries]);
        },
      }),
      1000,
    );
    queue.buffer("Sources/A.swift", [], "coll", undefined, [], [row]);
    queue.buffer("Sources/B.swift", [], "coll", undefined, [], []);

    await queue.flushRemainder("coll");

    expect(order).toEqual(["symbols", "identifiers", "typeDeclarations"]);
    expect(replaced).toEqual([
      [
        { relPath: "Sources/A.swift", rows: [row] },
        { relPath: "Sources/B.swift", rows: [] },
      ],
    ]);
  });

  it("does not write type declarations for files buffered without any", async () => {
    let calls = 0;
    const queue = new SymbolNodeFlushQueue(
      makeResolver({
        upsertSymbolsBulk: async () => undefined,
        replaceIdentifiersBulk: async () => undefined,
        replaceTypeDeclarationsBulk: async () => {
          calls += 1;
        },
      }),
      1000,
    );
    queue.buffer("Sources/A.swift", [], "coll", undefined, []);

    await queue.flushRemainder("coll");

    expect(calls).toBe(0);
  });
});
