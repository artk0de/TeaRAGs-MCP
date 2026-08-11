import { describe, expect, it } from "vitest";

import type { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import { DuckDbRunStatsStore } from "../../../../src/core/adapters/duckdb/run-stats-store.js";
import type { ResolveRunStatsRow } from "../../../../src/core/contracts/types/codegraph.js";

interface RecordedCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeSession(): { session: DuckDbGraphSession; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const session = {
    run: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve();
    },
    transaction: async (fn: () => Promise<void>) => fn(),
  } as unknown as DuckDbGraphSession;
  return { session, calls };
}

function row(language: string, receiverKind: string): ResolveRunStatsRow {
  return {
    language,
    receiverKind,
    attempted: 10,
    resolved: 7,
    externalSkipped: 1,
    unresolvable: 2,
  } as ResolveRunStatsRow;
}

describe("DuckDbRunStatsStore#recordRunStats — language-scoped overwrite", () => {
  it("deletes only the languages present in the incoming rows", async () => {
    // A run restricted to one language must not erase the breakdown of the
    // languages it never looked at: prime reads this table, so a wholesale
    // DELETE makes an untouched language vanish from the report.
    const { session, calls } = makeSession();
    await new DuckDbRunStatsStore(session).recordRunStats([row("typescript", "bareCall")]);

    const deletes = calls.filter((c) => c.sql.trim().toUpperCase().startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/WHERE\s+language\s+IN/i);
    expect(deletes[0].params).toEqual(["typescript"]);
  });

  it("names each distinct language once when rows span several", async () => {
    const { session, calls } = makeSession();
    await new DuckDbRunStatsStore(session).recordRunStats([
      row("typescript", "bareCall"),
      row("typescript", "dynamic"),
      row("ruby", "bareCall"),
    ]);

    const del = calls.find((c) => c.sql.trim().toUpperCase().startsWith("DELETE"));
    expect(del?.params).toEqual(["typescript", "ruby"]);
  });

  it("still inserts every row", async () => {
    const { session, calls } = makeSession();
    await new DuckDbRunStatsStore(session).recordRunStats([row("typescript", "bareCall"), row("ruby", "bareCall")]);

    expect(calls.filter((c) => c.sql.trim().toUpperCase().startsWith("INSERT"))).toHaveLength(2);
  });

  it("issues no DELETE at all when there are no rows", async () => {
    // `IN ()` is a syntax error, and an empty run has nothing to supersede.
    // Guarding here also keeps the old whole-table wipe from sneaking back as
    // the "no languages" case.
    const { session, calls } = makeSession();
    await new DuckDbRunStatsStore(session).recordRunStats([]);

    expect(calls.filter((c) => c.sql.trim().toUpperCase().startsWith("DELETE"))).toHaveLength(0);
  });
});
