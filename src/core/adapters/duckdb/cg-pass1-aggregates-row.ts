/**
 * The `cg_pass1_aggregates` row codec (bd tea-rags-mcp-znxg8) — the ONE place a
 * {@link CodegraphPass1FileAggregates} turns into persisted columns and back.
 * Same discipline as `cg-symbols-row.ts`: the write path and the hydration
 * SELECT share the column list and the two mapping functions, so a new field
 * cannot land on one and silently miss the other.
 *
 * The slice is stored as ONE json column rather than exploded into tables. It is
 * written whole, read back whole exactly once per run, and never queried by
 * field — the same reasoning that keeps `scope_json` a JSON-encoded VARCHAR in
 * `cg_symbols` (migration 002). Exploding it would buy query shapes nothing asks
 * for and cost four more reconciliation scopes.
 */

import type { CodegraphPass1FileAggregates } from "../../contracts/types/codegraph.js";

/**
 * The `cg_pass1_aggregates` PRIMARY KEY (migration 021). One row per file, so
 * the key is the path alone — unlike `cg_symbols`, where a file holds many
 * symbols and identity is (path, symbol).
 */
export const CG_PASS1_KEY_COLUMNS = ["rel_path"] as const;

/** The non-key columns — what the row diff compares to decide "unchanged". */
export const CG_PASS1_VALUE_COLUMNS = ["language", "aggregates_json"] as const;

/**
 * Every `cg_pass1_aggregates` column, key first — the order {@link toCgPass1Row}
 * emits and `applyScopedRowDiff` expects. Column names are compile-time
 * literals, never user input; every VALUE goes through a positional bind.
 */
export const CG_PASS1_DEF_COLUMNS: readonly string[] = [...CG_PASS1_KEY_COLUMNS, ...CG_PASS1_VALUE_COLUMNS];

/** Raw `cg_pass1_aggregates` row as read back by the hydration SELECT. */
export interface CgPass1AggregatesRow {
  rel_path: string;
  language: string;
  aggregates_json: string;
}

/**
 * The JSON payload — the aggregate slice minus the two columns that carry its
 * identity. Keeping `relPath` / `language` out of the blob means the row is
 * self-describing at the SQL level and the blob cannot disagree with its own key.
 */
type Pass1AggregatesPayload = Omit<CodegraphPass1FileAggregates, "relPath" | "language">;

/**
 * Project an aggregate slice onto the `cg_pass1_aggregates` tuple. Whether a
 * file is worth a row at all is the DOMAIN's call, not the codec's — see
 * `pass1-aggregates.ts` `buildPass1Aggregates`, which returns `undefined` for a
 * file that declares nothing.
 */
export function toCgPass1Row(aggregates: CodegraphPass1FileAggregates): unknown[] {
  const { relPath, language, ...payload } = aggregates;
  return [relPath, language, JSON.stringify(payload)];
}

/**
 * Rebuild an aggregate slice from its persisted row — the hydration seam every
 * incremental run goes through. A malformed blob degrades to "this file
 * contributed nothing", which is the pre-znxg8 behaviour for that file, never a
 * crash that would take the whole run's hydration with it.
 */
export function fromCgPass1Row(row: CgPass1AggregatesRow): CodegraphPass1FileAggregates {
  return { relPath: row.rel_path, language: row.language, ...parsePayload(row.aggregates_json) };
}

function parsePayload(json: string): Pass1AggregatesPayload {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Pass1AggregatesPayload)
      : {};
  } catch {
    return {};
  }
}

