/**
 * Persistence for `cg_identifiers` — the declared identifiers behind the naming
 * lexicon (bd tea-rags-mcp-4p3sb.8): one row per param / local / field a symbol
 * declares, plus a `return` row per symbol with a structured return type.
 *
 * Writes replace a file's rows as a whole. The table has no key (migration 032),
 * so the row diff `cg_symbols` uses has nothing to key on; the unit of change is
 * the FILE instead. A batch reads the stored rows of the files it names and
 * rewrites only the files whose row multiset moved — a recompute that re-walks
 * an unchanged file leaves its rows physically untouched, which is what the
 * `cg_symbols` diff buys for the same run shape. The DELETE that does run is
 * reclaimed at checkpoint: DuckDB vacuums deletes of a table with no index
 * (bd tea-rags-mcp-dvzdm), and the key-sharing delete+insert that aborts a
 * failed commit (bd tea-rags-mcp-tslvq) cannot occur without a key.
 *
 * Reads type an untyped row through the call it is bound to, at query time
 * (`call-return`): its `bound_call_expression` is the `call_expression` the
 * method-edge table keys on, and a call with exactly one `exact` edge lends the
 * target's `return` row type. Computed here, never written, so an incremental
 * reindex that changes a callee's return type is visible at once without
 * rewriting any caller's file.
 */

import type {
  AnchorIdentifierTypeRow,
  IdentifierCalleeAggregateRow,
  IdentifierCalleeScopeQuery,
  IdentifierDeclarationKind,
  IdentifierLanguageCountRow,
  IdentifierNameKindTypeRow,
  IdentifierNameScopeQuery,
  IdentifierNameTypeRow,
  IdentifierReplaceEntry,
  IdentifierRow,
  IdentifierScopeQuery,
  IdentifierShapeSampleQuery,
  IdentifierShapeSampleRow,
  IdentifierTypeAggregateRow,
  IdentifierTypeScopeQuery,
  IdentifierTypeSource,
  RelPath,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { escapeLikeLiteral } from "./sql-binding.js";

/** Column order of every `cg_identifiers` write and of the diff read. */
const CG_IDENTIFIERS_COLUMNS = [
  "rel_path",
  "owner_symbol_id",
  "kind",
  "name",
  "type_name",
  "type_source",
  "line",
  "bound_member",
  "bound_receiver",
  "bound_call_expression",
] as const;

/**
 * Values per `IN (…)` list — the bound the session's batched writers use, so a
 * caller's large batch never becomes one wide literal filter.
 */
const IDENTIFIER_IN_LIST_CHUNK = 200;

/** Fixed reservoir seed, so the same table state yields the same shape sample. */
const SHAPE_SAMPLE_SEED = 42;

/** A predicate fragment and its positional binds. */
export interface SqlPredicate {
  sql: string;
  params: unknown[];
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function chunked<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += IDENTIFIER_IN_LIST_CHUNK) {
    chunks.push(values.slice(i, i + IDENTIFIER_IN_LIST_CHUNK));
  }
  return chunks;
}

/** `rel_path` under any of `prefixes`, each matched as a literal (LIKE wildcards escaped). */
export function pathPrefixPredicate(prefixes: readonly string[] | undefined): SqlPredicate {
  if (prefixes === undefined || prefixes.length === 0) return { sql: "TRUE", params: [] };
  return {
    sql: `(${prefixes.map(() => "rel_path LIKE ? ESCAPE '\\'").join(" OR ")})`,
    params: prefixes.map((p) => `${escapeLikeLiteral(p)}%`),
  };
}

function toWriteRow(relPath: RelPath, row: IdentifierRow): unknown[] {
  return [
    relPath,
    row.ownerSymbolId,
    row.kind,
    row.name,
    row.typeName ?? null,
    row.typeSource ?? null,
    row.line,
    row.boundMember ?? null,
    row.boundReceiver ?? null,
    row.boundCallExpression ?? null,
  ];
}

/**
 * One row as a comparable string, identical for the caller's JS values and the
 * driver's read-back: NULL and `undefined` share a marker no string value can
 * produce, and `line` compares as text either way.
 */
function rowFingerprint(cells: readonly unknown[]): string {
  return JSON.stringify(cells.map(fingerprintCell));
}

/** Every `cg_identifiers` column is VARCHAR or INTEGER, so a cell is a string, a number or NULL. */
function fingerprintCell(cell: unknown): string | null {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "bigint") return cell.toString();
  return null;
}

function fileFingerprint(rowFingerprints: string[]): string {
  return rowFingerprints.sort().join("\n");
}

/**
 * `cg_identifiers` with every untyped row that is bound to a single-target
 * `exact` call typed by that target's `return` row. `scope` narrows the rows
 * BEFORE the join, so the edge scan only meets the calls the scope binds.
 *
 * A call's targets are counted over its `exact` edges only; two of them (a
 * method defined in two files) type nothing. A target whose `return` rows
 * disagree on the type types nothing either.
 */
export function resolvedIdentifiersCte(scope: SqlPredicate): SqlPredicate {
  return {
    sql: `WITH scoped AS (
        SELECT * FROM cg_identifiers WHERE ${scope.sql}
      ),
      call_targets AS (
        SELECT e.source_rel_path, e.source_symbol_id, e.call_expression,
               any_value(e.target_rel_path) AS target_rel_path,
               any_value(e.target_symbol_id) AS target_symbol_id
          FROM cg_symbols_edges_method e
         WHERE e.edge_kind = 'exact'
           AND EXISTS (
             SELECT 1 FROM scoped b
              WHERE b.type_name IS NULL
                AND b.rel_path = e.source_rel_path
                AND b.owner_symbol_id = e.source_symbol_id
                AND b.bound_call_expression = e.call_expression
           )
         GROUP BY e.source_rel_path, e.source_symbol_id, e.call_expression
        HAVING count(*) = 1
      ),
      return_types AS (
        SELECT rel_path, owner_symbol_id, min(type_name) AS type_name
          FROM cg_identifiers
         WHERE kind = 'return' AND type_name IS NOT NULL
         GROUP BY rel_path, owner_symbol_id
        HAVING count(DISTINCT type_name) = 1
      ),
      resolved AS (
        SELECT s.rel_path, s.owner_symbol_id, s.kind, s.name, s.line,
               COALESCE(s.type_name, r.type_name) AS type_name,
               CASE
                 WHEN s.type_name IS NOT NULL THEN s.type_source
                 WHEN r.type_name IS NOT NULL THEN 'call-return'
               END AS type_source
          FROM scoped s
          LEFT JOIN call_targets t
            ON s.type_name IS NULL
           AND t.source_rel_path = s.rel_path
           AND t.source_symbol_id = s.owner_symbol_id
           AND t.call_expression = s.bound_call_expression
          LEFT JOIN return_types r
            ON r.rel_path = t.target_rel_path
           AND r.owner_symbol_id = t.target_symbol_id
      )`,
    params: scope.params,
  };
}

export class DuckDbIdentifierStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lastByRelPath = new Map<RelPath, readonly IdentifierRow[]>();
    for (const { relPath, rows } of entries) lastByRelPath.set(relPath, rows);
    const relPaths = [...lastByRelPath.keys()];

    return this.session.transaction(async () => {
      const stored = new Map<RelPath, string[]>();
      for (const chunk of chunked(relPaths)) {
        const found = await this.session.queryAll<Record<string, unknown>>(
          `SELECT ${CG_IDENTIFIERS_COLUMNS.join(", ")} FROM cg_identifiers WHERE rel_path IN (${placeholders(chunk)})`,
          chunk,
        );
        for (const row of found) {
          const relPath = row.rel_path as RelPath;
          const list = stored.get(relPath) ?? [];
          list.push(rowFingerprint(CG_IDENTIFIERS_COLUMNS.map((c) => row[c])));
          stored.set(relPath, list);
        }
      }

      const changed: RelPath[] = [];
      const inserts: unknown[][] = [];
      for (const [relPath, rows] of lastByRelPath) {
        const writeRows = rows.map((r) => toWriteRow(relPath, r));
        const incoming = fileFingerprint(writeRows.map(rowFingerprint));
        if (incoming === fileFingerprint(stored.get(relPath) ?? [])) continue;
        changed.push(relPath);
        inserts.push(...writeRows);
      }

      for (const chunk of chunked(changed)) {
        await this.session.run(`DELETE FROM cg_identifiers WHERE rel_path IN (${placeholders(chunk)})`, chunk);
      }
      await this.session.insertBatched("cg_identifiers", CG_IDENTIFIERS_COLUMNS, inserts);
    });
  }

  async aggregateIdentifiersByType(q: IdentifierTypeScopeQuery): Promise<IdentifierTypeAggregateRow[]> {
    if (q.types.length === 0) return [];
    const cte = resolvedIdentifiersCte(pathPrefixPredicate(q.pathPrefixes));
    const rows = await this.session.queryAll<{
      type_name: string;
      kind: string;
      name: string;
      type_source: string;
      n: number | string;
      example_owner: string;
    }>(
      `${cte.sql}
       SELECT type_name, kind, name, type_source, count(*) AS n, min(owner_symbol_id) AS example_owner
         FROM resolved
        WHERE type_name IN (${placeholders(q.types)})
        GROUP BY type_name, kind, name, type_source
        ORDER BY n DESC, type_name, kind, name, type_source`,
      [...cte.params, ...q.types],
    );
    return rows.map((r) => ({
      typeName: r.type_name,
      kind: r.kind as IdentifierDeclarationKind,
      name: r.name,
      typeSource: r.type_source as IdentifierTypeSource,
      n: Number(r.n),
      exampleOwner: r.example_owner,
    }));
  }

  async countIdentifiers(q: IdentifierTypeScopeQuery): Promise<number> {
    if (q.types.length === 0) return 0;
    const cte = resolvedIdentifiersCte(pathPrefixPredicate(q.pathPrefixes));
    const rows = await this.session.queryAll<{ n: number | string }>(
      `${cte.sql}
       SELECT count(*) AS n FROM resolved WHERE type_name IN (${placeholders(q.types)})`,
      [...cte.params, ...q.types],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async aggregateIdentifiersByCallee(q: IdentifierCalleeScopeQuery): Promise<IdentifierCalleeAggregateRow[]> {
    if (q.callees.length === 0) return [];
    const scope = pathPrefixPredicate(q.pathPrefixes);
    const calleeParams: unknown[] = [];
    const calleeSql = q.callees
      .map((callee) => {
        calleeParams.push(callee.member);
        if (callee.receiver === undefined) return "(bound_member = ?)";
        calleeParams.push(callee.receiver);
        return "(bound_member = ? AND bound_receiver = ?)";
      })
      .join(" OR ");
    const rows = await this.session.queryAll<{
      bound_member: string;
      bound_receiver: string | null;
      kind: string;
      name: string;
      type_name: string | null;
      n: number | string;
      example_owner: string;
    }>(
      `SELECT bound_member, bound_receiver, kind, name, type_name, count(*) AS n,
              min(owner_symbol_id) AS example_owner
         FROM cg_identifiers
        WHERE ${scope.sql} AND (${calleeSql})
        GROUP BY bound_member, bound_receiver, kind, name, type_name
        ORDER BY n DESC, bound_member, bound_receiver NULLS FIRST, kind, name, type_name NULLS FIRST`,
      [...scope.params, ...calleeParams],
    );
    return rows.map((r) => ({
      member: r.bound_member,
      receiver: r.bound_receiver,
      kind: r.kind as IdentifierDeclarationKind,
      name: r.name,
      n: Number(r.n),
      exampleOwner: r.example_owner,
      ...(r.type_name === null ? {} : { typeName: r.type_name }),
    }));
  }

  async anchorIdentifierTypes(symbolIds: readonly SymbolId[]): Promise<AnchorIdentifierTypeRow[]> {
    const out: AnchorIdentifierTypeRow[] = [];
    for (const chunk of chunked([...new Set(symbolIds)])) {
      const rows = await this.session.queryAll<{ owner_symbol_id: string; kind: string; type_name: string }>(
        `SELECT DISTINCT owner_symbol_id, kind, type_name FROM cg_identifiers
          WHERE owner_symbol_id IN (${placeholders(chunk)})
            AND kind IN ('param', 'return')
            AND type_name IS NOT NULL
          ORDER BY owner_symbol_id, kind, type_name`,
        chunk,
      );
      for (const r of rows) {
        out.push({ ownerSymbolId: r.owner_symbol_id, kind: r.kind as "param" | "return", typeName: r.type_name });
      }
    }
    return out;
  }

  async identifierNameTypes(names: readonly string[]): Promise<IdentifierNameTypeRow[]> {
    const out: IdentifierNameTypeRow[] = [];
    for (const chunk of chunked([...new Set(names)])) {
      const cte = resolvedIdentifiersCte({ sql: `name IN (${placeholders(chunk)})`, params: chunk });
      const rows = await this.session.queryAll<{ name: string; type_name: string | null; n: number | string }>(
        `${cte.sql}
         SELECT name, type_name, count(*) AS n FROM resolved
          GROUP BY name, type_name
          ORDER BY name, n DESC, type_name NULLS LAST`,
        cte.params,
      );
      for (const r of rows) out.push({ name: r.name, typeName: r.type_name, n: Number(r.n) });
    }
    return out;
  }

  async aggregateIdentifiersByName(q: IdentifierNameScopeQuery): Promise<IdentifierNameKindTypeRow[]> {
    const out: IdentifierNameKindTypeRow[] = [];
    const scope = pathPrefixPredicate(q.pathPrefixes);
    for (const chunk of chunked([...new Set(q.names)])) {
      const cte = resolvedIdentifiersCte({
        sql: `name IN (${placeholders(chunk)}) AND ${scope.sql}`,
        params: [...chunk, ...scope.params],
      });
      const rows = await this.session.queryAll<{
        name: string;
        kind: string;
        type_name: string | null;
        n: number | string;
        example_owner: string;
      }>(
        `${cte.sql}
         SELECT name, kind, type_name, count(*) AS n, min(owner_symbol_id) AS example_owner
           FROM resolved
          GROUP BY name, kind, type_name
          ORDER BY name, kind, type_name NULLS LAST`,
        cte.params,
      );
      for (const r of rows) {
        out.push({
          name: r.name,
          kind: r.kind as IdentifierDeclarationKind,
          typeName: r.type_name,
          n: Number(r.n),
          exampleOwner: r.example_owner,
        });
      }
    }
    return out;
  }

  async identifierLanguageCounts(q: IdentifierScopeQuery): Promise<IdentifierLanguageCountRow[]> {
    const scope = pathPrefixPredicate(q.pathPrefixes);
    const rows = await this.session.queryAll<{ language: string | null; n: number | string }>(
      `SELECT f.language, count(*) AS n
         FROM (SELECT rel_path FROM cg_identifiers WHERE ${scope.sql}) i
         LEFT JOIN cg_symbols_files f ON f.rel_path = i.rel_path
        GROUP BY f.language
        ORDER BY n DESC, f.language NULLS LAST`,
      scope.params,
    );
    return rows.map((r) => ({ language: r.language, n: Number(r.n) }));
  }

  async sampleIdentifierShapes(q: IdentifierShapeSampleQuery): Promise<IdentifierShapeSampleRow[]> {
    const scope = pathPrefixPredicate(q.pathPrefixes);
    // The reservoir size is inlined: DuckDB takes no bind parameter there. It is
    // coerced to a positive integer first, so no caller value reaches the SQL text.
    const limit = Math.max(1, Math.floor(Number(q.limit) || 1));
    const rows = await this.session.queryAll<{
      kind: string;
      name: string;
      type_name: string | null;
      bound_member: string | null;
      bound_receiver: string | null;
      n: number | string;
    }>(
      `SELECT kind, name, type_name, bound_member, bound_receiver, count(*) AS n
         FROM (
           SELECT * FROM (
             SELECT kind, name, type_name, bound_member, bound_receiver FROM cg_identifiers
              WHERE ${scope.sql} AND (type_name IS NOT NULL OR bound_member IS NOT NULL)
           ) USING SAMPLE reservoir(${limit} ROWS) REPEATABLE (${SHAPE_SAMPLE_SEED})
         )
        GROUP BY kind, name, type_name, bound_member, bound_receiver
        ORDER BY n DESC, kind, name`,
      scope.params,
    );
    return rows.map((r) => ({
      kind: r.kind as IdentifierDeclarationKind,
      name: r.name,
      typeName: r.type_name,
      boundMember: r.bound_member,
      boundReceiver: r.bound_receiver,
      n: Number(r.n),
    }));
  }

  async existingSymbolShortNames(names: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunked([...new Set(names)])) {
      const rows = await this.session.queryAll<{ short_name: string }>(
        `SELECT DISTINCT short_name FROM cg_symbols WHERE short_name IN (${placeholders(chunk)}) ORDER BY short_name`,
        chunk,
      );
      for (const r of rows) out.push(r.short_name);
    }
    return out;
  }
}
