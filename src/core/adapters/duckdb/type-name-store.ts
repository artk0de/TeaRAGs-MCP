/**
 * The type-level symbols type roles are derived from (bd tea-rags-mcp-vi0wx):
 * `cg_symbols` rows of a type-level `symbol_kind`, each with its direct
 * ancestors from `cg_symbols_inheritance` folded in by `list()`. One read, no
 * persisted aggregate — the roles are recomputed at read time.
 *
 * The scope is the ontology report's: the same literal path-prefix helper and
 * the same compiled non-production predicate, so the two audits agree on what
 * "the project" is. `excludePaths` (diff mode's changed files) is a bind list:
 * the diff cap bounds it at 200, unlike the unbounded file lists that forced
 * the non-production masks into constant SQL.
 */

import type { SymbolDefinitionKind } from "../../contracts/types/codegraph-symbols.js";
import type { TypeNameQuery, TypeNameRow } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { pathPrefixPredicate, type SqlPredicate } from "./identifier-store.js";
import { compileNonProductionPathPredicate } from "./non-production-path-sql.js";
import { placeholders } from "./sql-binding.js";

function excludedPathsPredicate(paths: readonly string[] | undefined): SqlPredicate {
  if (paths === undefined || paths.length === 0) return { sql: "TRUE", params: [] };
  return { sql: `s.rel_path NOT IN (${placeholders(paths)})`, params: [...paths] };
}

export class DuckDbTypeNameStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]> {
    if (q.kinds.length === 0) return [];
    const prefix = pathPrefixPredicate(q.pathPrefixes);
    const nonProduction = compileNonProductionPathPredicate(q.nonProductionPaths);
    const excluded = excludedPathsPredicate(q.excludePaths);
    const rows = await this.session.queryAll<{
      symbol_id: string;
      rel_path: string;
      short_name: string;
      symbol_kind: SymbolDefinitionKind;
      ancestors: string[] | null;
    }>(
      `SELECT s.symbol_id, s.rel_path, s.short_name, s.symbol_kind,
              list(i.ancestor_fq_name ORDER BY i.ordinal, i.ancestor_fq_name)
                FILTER (WHERE i.ancestor_fq_name IS NOT NULL) AS ancestors
         FROM cg_symbols s
         LEFT JOIN cg_symbols_inheritance i
           ON i.source_fq_name = s.fq_name AND i.source_rel_path = s.rel_path
        WHERE s.symbol_kind IN (${placeholders(q.kinds)})
          AND ${prefix.sql}
          AND NOT ${nonProduction("s.rel_path")}
          AND ${excluded.sql}
        GROUP BY s.symbol_id, s.rel_path, s.short_name, s.symbol_kind
        ORDER BY s.rel_path, s.symbol_id`,
      [...q.kinds, ...prefix.params, ...excluded.params],
    );
    return rows.map((r) => ({
      symbolId: r.symbol_id,
      relPath: r.rel_path,
      shortName: r.short_name,
      symbolKind: r.symbol_kind,
      ancestors: r.ancestors ?? [],
    }));
  }
}
