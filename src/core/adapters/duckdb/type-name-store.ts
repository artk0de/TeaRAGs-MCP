/**
 * Persistence for `cg_type_declarations` (migration 038) — the type-level
 * declarations type roles are derived from (bd tea-rags-mcp-vi0wx / l2pkp,
 * spec §1b). One read, no persisted aggregate — the roles are recomputed at
 * read time.
 *
 * Writes replace a file's rows as a whole, the way `DuckDbIdentifierStore`
 * does for `cg_identifiers`: the table has no key, so the unit of change is the
 * FILE. A batch reads the stored rows of the files it names and rewrites only
 * the files whose row multiset moved, so a recompute that re-walks an unchanged
 * file leaves its rows physically untouched.
 *
 * The read's scope is the ontology report's: the same literal path-prefix
 * helper and the same compiled non-production predicate, so the two audits
 * agree on what "the project" is. `excludePaths` (diff mode's changed files) is
 * a bind list: the diff cap bounds it at 200, unlike the unbounded file lists
 * that forced the non-production masks into constant SQL.
 */

import type { SymbolDefinitionKind } from "../../contracts/types/codegraph-symbols.js";
import type {
  RelPath,
  TypeDeclarationReplaceEntry,
  TypeDeclarationRow,
  TypeNameQuery,
  TypeNameRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { excludedPathsPredicate, pathPrefixPredicate } from "./identifier-store.js";
import { compileNonProductionPathPredicate } from "./non-production-path-sql.js";
import { placeholders } from "./sql-binding.js";

/** Column order of every `cg_type_declarations` write and of the diff read. */
const CG_TYPE_DECLARATIONS_COLUMNS = [
  "rel_path",
  "language",
  "type_id",
  "short_name",
  "symbol_kind",
  "line",
  "reopens",
  // Migration 040 (bd tea-rags-mcp-ffxfc): the declaration's member census, NULL when it has none.
  "method_count",
  "field_count",
  // Last: the only cell the tuple casts, see TYPE_DECLARATION_TUPLE.
  "supertypes",
] as const;

/**
 * Values per `IN (…)` list and rows per multi-row `INSERT` — the bound the
 * session's batched writers use.
 */
const TYPE_DECLARATION_CHUNK = 200;

/**
 * One row's `VALUES` tuple. The session binds primitives only, so the
 * supertype list travels as JSON text and is cast to `VARCHAR[]` in SQL.
 */
const TYPE_DECLARATION_TUPLE = "(?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(CAST(? AS JSON) AS VARCHAR[]))";

function chunkedTypeDeclarationValues<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += TYPE_DECLARATION_CHUNK) {
    chunks.push(values.slice(i, i + TYPE_DECLARATION_CHUNK));
  }
  return chunks;
}

/** A row's cells in {@link CG_TYPE_DECLARATIONS_COLUMNS} order, supertypes still a list. */
function typeDeclarationCells(relPath: RelPath, row: TypeDeclarationRow): unknown[] {
  return [
    relPath,
    row.language,
    row.typeId,
    row.shortName,
    row.symbolKind,
    row.line,
    row.reopens,
    row.methodCount ?? null,
    row.fieldCount ?? null,
    [...row.supertypes],
  ];
}

/** A file's rows as one order-independent fingerprint — equal iff the row multisets are. */
function typeDeclarationFileFingerprint(rows: readonly (readonly unknown[])[]): string {
  return rows
    .map((cells) => JSON.stringify(cells))
    .sort()
    .join("\n");
}

export class DuckDbTypeNameStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async replaceTypeDeclarationsBulk(entries: readonly TypeDeclarationReplaceEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lastByRelPath = new Map<RelPath, readonly TypeDeclarationRow[]>();
    for (const { relPath, rows } of entries) lastByRelPath.set(relPath, rows);
    const relPaths = [...lastByRelPath.keys()];

    return this.session.transaction(async () => {
      const stored = new Map<RelPath, unknown[][]>();
      for (const chunk of chunkedTypeDeclarationValues(relPaths)) {
        const found = await this.session.queryAll<Record<string, unknown>>(
          `SELECT ${CG_TYPE_DECLARATIONS_COLUMNS.join(", ")} FROM cg_type_declarations
            WHERE rel_path IN (${placeholders(chunk)})`,
          chunk,
        );
        for (const row of found) {
          const relPath = row.rel_path as RelPath;
          const list = stored.get(relPath) ?? [];
          list.push(CG_TYPE_DECLARATIONS_COLUMNS.map((c) => row[c]));
          stored.set(relPath, list);
        }
      }

      const changed: RelPath[] = [];
      const inserts: unknown[][] = [];
      for (const [relPath, rows] of lastByRelPath) {
        const cells = rows.map((r) => typeDeclarationCells(relPath, r));
        const unchanged =
          typeDeclarationFileFingerprint(cells) === typeDeclarationFileFingerprint(stored.get(relPath) ?? []);
        if (unchanged) continue;
        changed.push(relPath);
        inserts.push(...cells);
      }

      for (const chunk of chunkedTypeDeclarationValues(changed)) {
        await this.session.run(`DELETE FROM cg_type_declarations WHERE rel_path IN (${placeholders(chunk)})`, chunk);
      }
      const prefix = `INSERT INTO cg_type_declarations (${CG_TYPE_DECLARATIONS_COLUMNS.join(", ")}) VALUES `;
      for (const chunk of chunkedTypeDeclarationValues(inserts)) {
        const params = chunk.flatMap((cells) => [...cells.slice(0, -1), JSON.stringify(cells.at(-1))]);
        await this.session.run(prefix + chunk.map(() => TYPE_DECLARATION_TUPLE).join(", "), params);
      }
    });
  }

  async readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]> {
    if (q.kinds.length === 0 || q.languages?.length === 0) return [];
    const prefix = pathPrefixPredicate(q.pathPrefixes);
    const nonProduction = compileNonProductionPathPredicate(q.nonProductionPaths);
    const excluded = excludedPathsPredicate(q.excludePaths);
    const languages =
      q.languages === undefined
        ? { sql: "TRUE", params: [] as string[] }
        : { sql: `language IN (${placeholders(q.languages)})`, params: [...q.languages] };
    // The member census is the TYPE's (bd tea-rags-mcp-ffxfc): summed over every
    // production row of the same language and id, re-openings included, and
    // independent of the scope the types are read in. A type none of whose rows
    // carries a census has no `members` row, so both counts read back NULL.
    const rows = await this.session.queryAll<{
      type_id: string;
      rel_path: string;
      short_name: string;
      symbol_kind: SymbolDefinitionKind;
      supertypes: string[];
      method_count: number | null;
      field_count: number | null;
    }>(
      `WITH members AS (
         SELECT language, type_id,
                CAST(SUM(method_count) AS INTEGER) AS method_count,
                CAST(SUM(field_count) AS INTEGER) AS field_count
           FROM cg_type_declarations
          WHERE method_count IS NOT NULL
            AND field_count IS NOT NULL
            AND NOT ${nonProduction("rel_path")}
          GROUP BY language, type_id
       ),
       scoped AS (
         SELECT language, type_id, rel_path, short_name, symbol_kind, supertypes, line
           FROM cg_type_declarations
          WHERE NOT reopens
            AND symbol_kind IN (${placeholders(q.kinds)})
            AND ${prefix.sql}
            AND NOT ${nonProduction("rel_path")}
            AND ${excluded.sql}
            AND ${languages.sql}
       )
       SELECT s.type_id, s.rel_path, s.short_name, s.symbol_kind, s.supertypes, m.method_count, m.field_count
         FROM scoped s
         LEFT JOIN members m ON m.language = s.language AND m.type_id = s.type_id
        ORDER BY s.rel_path, s.line, s.type_id`,
      [...q.kinds, ...prefix.params, ...excluded.params, ...languages.params],
    );
    return rows.map((r) => {
      const row: TypeNameRow = {
        symbolId: r.type_id,
        relPath: r.rel_path,
        shortName: r.short_name,
        symbolKind: r.symbol_kind,
        ancestors: r.supertypes,
      };
      return r.method_count === null || r.field_count === null
        ? row
        : { ...row, methodCount: Number(r.method_count), fieldCount: Number(r.field_count) };
    });
  }
}
