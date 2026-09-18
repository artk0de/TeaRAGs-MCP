import type { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";

/**
 * Every row of every `cg_*` table, as sorted JSON lines per table — the
 * persisted graph a run leaves, in a shape two runs can be compared on
 * byte-for-byte.
 *
 * Rows are sorted as strings because no table's physical order is part of its
 * meaning. Columns named `*_at` are wall-clock stamps of WHEN a write landed,
 * not WHAT it wrote, so they are blanked; nothing else is normalised.
 */
export async function dumpCodegraphTables(client: DuckDbGraphClient): Promise<Record<string, string[]>> {
  const tables = await client.queryAll<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name LIKE 'cg_%' ORDER BY table_name",
  );
  const dump: Record<string, string[]> = {};
  for (const { table_name: table } of tables) {
    const rows = await client.queryAll<Record<string, unknown>>(`SELECT * FROM ${table}`);
    dump[table] = rows.map((row) => stableRow(row)).sort();
  }
  return dump;
}

/**
 * The two `cg_*` tables whose persisted form depends on the ORDER edges are
 * stored in, not only on which edges exist: Tarjan numbers cycles (and orders
 * their members) in DFS order, and PageRank accumulates DOUBLEs in iteration
 * order. Both walk the edge tables in storage order, which no writer controls
 * canonically. Compare them by meaning — {@link cycleMemberSets},
 * {@link pageRanksBySymbol} — and everything else byte for byte.
 */
export const ORDER_SENSITIVE_ANALYTICS_TABLES: readonly string[] = ["cg_symbols_cycles", "cg_symbols_metrics"];

/**
 * The absolute tolerance under which two PageRank values are the same value —
 * the codebase's own definition (`PAGE_RANK_EPSILON` in the adapter's
 * signal-drift store): well above DOUBLE accumulation noise, well below any
 * move the payload heal would act on.
 */
export const PAGE_RANK_EPSILON = 1e-12;

/** Each cycle as `scope:member,member,…` with members sorted, the list sorted. */
export function cycleMemberSets(rows: readonly string[]): string[] {
  const members = new Map<string, string[]>();
  for (const line of rows) {
    const row = JSON.parse(line) as { scope: string; cycle_id: number | string; member: string };
    const key = `${row.scope}#${row.cycle_id}`;
    const list = members.get(key) ?? [];
    list.push(row.member);
    members.set(key, list);
  }
  return [...members].map(([key, list]) => `${key.split("#")[0]}:${list.sort().join(",")}`).sort();
}

/** `symbol_id → page_rank` of a `cg_symbols_metrics` dump. */
export function pageRanksBySymbol(rows: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of rows) {
    const row = JSON.parse(line) as { symbol_id: string; page_rank: number };
    out.set(row.symbol_id, Number(row.page_rank));
  }
  return out;
}

function stableRow(row: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    normalized[key] = key.endsWith("_at") ? "<stamp>" : row[key];
  }
  return JSON.stringify(normalized, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}
