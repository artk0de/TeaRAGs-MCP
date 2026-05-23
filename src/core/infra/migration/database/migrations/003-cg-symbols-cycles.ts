/**
 * Slice 2 codegraph schema — `cg_symbols_cycles`.
 *
 * Persists strongly-connected components (SCCs) of the import / call
 * graph as compute-once tables. Tarjan's SCC algorithm runs at sink
 * finish time (or after force-reindex) and rewrites the table for the
 * given scope; the `find_cycles` MCP tool reads sub-ms.
 *
 * scope is 'file' (import graph over cg_symbols_edges_file) or
 * 'method' (call graph over cg_symbols_edges_method). Members are
 * relPath strings (file scope) or symbolId strings (method scope).
 * Cycles of length 1 (self-loops) are intentionally excluded — they're
 * either harmless or already surfaced by other signals; only multi-node
 * SCCs are real circular-dependency findings.
 */
export const SQL_003_CG_SYMBOLS_CYCLES = `
CREATE TABLE IF NOT EXISTS cg_symbols_cycles (
  cycle_id    INTEGER NOT NULL,
  scope       VARCHAR NOT NULL,
  member      VARCHAR NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, scope, member)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_cycles_scope ON cg_symbols_cycles (scope);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_cycles_member ON cg_symbols_cycles (member);
`;
