import { describe, expect, it, vi } from "vitest";

import { DuckDbFieldAccessStore } from "../../../../src/core/adapters/duckdb/field-access-store.js";
import type { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";

interface DbRow {
  source_rel_path: string;
  source_symbol_id: string;
  owner_kind: string;
  owner_type: string | null;
  receiver: string | null;
  field_name: string;
  access_kind: string;
  access_count: number;
  first_line: number | null;
}

function row(overrides: Partial<DbRow>): DbRow {
  return {
    source_rel_path: "a.ts",
    source_symbol_id: "A#m",
    owner_kind: "this",
    owner_type: null,
    receiver: null,
    field_name: "x",
    access_kind: "read",
    access_count: 1,
    first_line: 3,
    ...overrides,
  };
}

/** A session answering each `IN (…)` chunk with the next canned batch. */
function sessionAnswering(batches: DbRow[][]): { session: DuckDbGraphSession; queryAll: ReturnType<typeof vi.fn> } {
  const queryAll = vi.fn(async () => batches.shift() ?? []);
  return { session: { queryAll } as unknown as DuckDbGraphSession, queryAll };
}

describe("DuckDbFieldAccessStore chunked reads", () => {
  it("answers an empty list without querying", async () => {
    const { session, queryAll } = sessionAnswering([]);
    expect(await new DuckDbFieldAccessStore(session).readFieldAccessesBySymbols([])).toEqual([]);
    expect(queryAll).not.toHaveBeenCalled();
  });

  it("splits a wide read into bind chunks and restores the SQL order across them (symbol key first)", async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `S${String(index).padStart(3, "0")}`);
    const { session, queryAll } = sessionAnswering([
      [row({ source_symbol_id: "S050", field_name: "b" }), row({ source_symbol_id: "S300", field_name: "a" })],
      [
        row({ source_symbol_id: "S050", field_name: "a" }),
        row({ source_symbol_id: "S050", source_rel_path: "0.ts", field_name: "z" }),
      ],
      [row({ source_symbol_id: "S010", owner_type: "Base", receiver: "r", first_line: null })],
    ]);

    const rows = await new DuckDbFieldAccessStore(session).readFieldAccessesBySymbols([...ids, ids[0]]);

    // 450 unique ids at 200 per IN list -> 3 queries, the duplicate id dropped.
    expect(queryAll).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => `${r.sourceSymbolId}|${r.relPath}|${r.fieldName}`)).toEqual([
      "S010|a.ts|x",
      "S050|0.ts|z",
      "S050|a.ts|a",
      "S050|a.ts|b",
      "S300|a.ts|a",
    ]);
    expect(rows[0]).toMatchObject({ ownerType: "Base", receiver: "r" });
  });

  it("orders a multi-chunk file read by path first, then by symbol and the tie columns", async () => {
    const paths = Array.from({ length: 201 }, (_, index) => `f${String(index).padStart(3, "0")}.ts`);
    const { session } = sessionAnswering([
      [row({ source_rel_path: "f009.ts", source_symbol_id: "B", access_kind: "write" })],
      [
        row({ source_rel_path: "f009.ts", source_symbol_id: "B", access_kind: "read" }),
        row({ source_rel_path: "f001.ts", source_symbol_id: "Z", owner_kind: "static" }),
        row({ source_rel_path: "f009.ts", source_symbol_id: "A", owner_kind: "this", owner_type: "T" }),
      ],
    ]);

    const rows = await new DuckDbFieldAccessStore(session).readFieldAccessesByFiles(paths);

    expect(rows.map((r) => `${r.relPath}|${r.sourceSymbolId}|${r.accessKind}`)).toEqual([
      "f001.ts|Z|read",
      "f009.ts|A|read",
      "f009.ts|B|read",
      "f009.ts|B|write",
    ]);
  });
});
