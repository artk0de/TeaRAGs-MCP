/**
 * Persistence for `cg_identifiers` — the declared identifiers behind the naming
 * lexicon (bd tea-rags-mcp-4p3sb.8): one row per param / local / field a symbol
 * declares, plus a `return` row per symbol with a structured return type.
 *
 * Writes replace a file's rows as a whole. The table has no key (migration 033),
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
  CallableSymbolKind,
  IdentifierCalleeAggregateRow,
  IdentifierCalleeScopeQuery,
  IdentifierDeclarationKind,
  IdentifierLanguageCountQuery,
  IdentifierLanguageCountRow,
  IdentifierNameKindTypeRow,
  IdentifierNameScopeQuery,
  IdentifierNameTypeRow,
  IdentifierReplaceEntry,
  IdentifierRow,
  IdentifierShapeSampleQuery,
  IdentifierShapeSampleRow,
  IdentifierTypeAggregateQuery,
  IdentifierTypeAggregateRow,
  IdentifierTypeMultiplicity,
  IdentifierTypeScopeQuery,
  IdentifierTypeSource,
  MethodHeadWordQuery,
  MethodHeadWordRow,
  MethodNamePatternQuery,
  MethodNameRow,
  MethodNameScopeQuery,
  MethodTailVerbQuery,
  MethodTailVerbRow,
  RelPath,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { compileNonProductionPathPredicate } from "./non-production-path-sql.js";
import { escapeLikeLiteral, placeholders } from "./sql-binding.js";

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
  "type_multiplicity",
  "bound_call_unwrapped",
  "return_wrapper",
] as const;

/**
 * Values per `IN (…)` list — the bound the session's batched writers use, so a
 * caller's large batch never becomes one wide literal filter.
 */
const IDENTIFIER_IN_LIST_CHUNK = 200;

/**
 * A row that is a DECLARATION: every row but a wrapper-only `return` (bd
 * tea-rags-mcp-bjzaf), which carries a `return_wrapper` and no type and exists
 * for the call-return join alone. Reads that report or count declarations
 * filter on it, so they see the rows they saw before such rows existed.
 */
export const DECLARED_IDENTIFIER_SQL = "NOT (kind = 'return' AND type_name IS NULL)";

/** Constructor names across the supported languages — never a method name the lexicon judges. */
const CONSTRUCTOR_NAMES = ["initialize", "constructor", "__init__"] as const;

/** A method name without its trailing `!` / `?` markers. */
const METHOD_UNMARKED_SQL = "regexp_replace(short_name, '[!?]+$', '')";
/** A method name's head word: its leading lowercase run before `_` or a capital; `''` for none. */
const METHOD_HEAD_SQL = "regexp_extract(short_name, '^([a-z][a-z0-9]*)[_A-Z]', 1)";
/** The noun tail after {@link METHOD_HEAD_SQL}, normalized across casings: `_user_name!`, `UserName` → `username`. */
const METHOD_TAIL_SQL = `lower(replace(regexp_replace(${METHOD_UNMARKED_SQL}, '^[a-z][a-z0-9]*', ''), '_', ''))`;
/** A method name as the compound it spells, trailing `!` / `?` / `=` dropped: `date_published=` → `date_published`. */
const METHOD_COMPOUND_SQL = "regexp_replace(short_name, '[!?=]+$', '')";
/** A declared identifier's name without a leading `@` / `@@` sigil: `@@media_attachment` → `media_attachment`. */
const IDENTIFIER_VALUE_NAME_SQL = "regexp_replace(name, '^@@?', '')";
/** A method name's last word, lowercased: `load_user`, `loadUser` → `user`. */
const METHOD_LAST_WORD_SQL = `lower(regexp_extract(${METHOD_UNMARKED_SQL}, '([A-Z]?[a-z0-9]+)$', 1))`;

/**
 * The `cg_symbols` rows a method-name read sees: `method` / `function`
 * symbols, no constructor, in production files of the evidence scope.
 */
function methodNameScopePredicate(q: MethodNameScopeQuery): SqlPredicate {
  const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
  const nonProduction = compileNonProductionPathPredicate(q.nonProductionPaths);
  return {
    sql: `symbol_kind IN ('method', 'function')
            AND short_name NOT IN (${placeholders(CONSTRUCTOR_NAMES)})
            AND ${scope.sql} AND NOT ${nonProduction("rel_path")}`,
    params: [...CONSTRUCTOR_NAMES, ...scope.params],
  };
}

/**
 * The `cg_identifiers` rows a method-name read may meet as names of values:
 * every declaration but a `return` row, in production files of the SAME
 * evidence scope {@link methodNameScopePredicate} reads the methods from.
 */
function methodValueScopePredicate(q: MethodNameScopeQuery): SqlPredicate {
  const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
  const nonProduction = compileNonProductionPathPredicate(q.nonProductionPaths);
  return {
    sql: `kind <> 'return' AND ${scope.sql} AND NOT ${nonProduction("rel_path")}`,
    params: [...scope.params],
  };
}

/** Fixed reservoir seed, so the same table state yields the same shape sample. */
const SHAPE_SAMPLE_SEED = 42;

/** A predicate fragment and its positional binds. */
export interface SqlPredicate {
  sql: string;
  params: unknown[];
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

/**
 * `rel_path` outside `paths` (`IdentifierEvidenceExclusion.excludePaths`) —
 * a bind list, bounded by the diff cap; `TRUE` when there is none.
 */
export function excludedPathsPredicate(paths: readonly string[] | undefined): SqlPredicate {
  if (paths === undefined || paths.length === 0) return { sql: "TRUE", params: [] };
  return { sql: `rel_path NOT IN (${placeholders(paths)})`, params: [...paths] };
}

/**
 * `rel_path` of a file not written in another language than `languages`
 * (`IdentifierLanguageScope`, bd tea-rags-mcp-0qaht) — the rel_path → language
 * mapping {@link fileLanguageGrouping} joins, read as a filter: a predicate over
 * `rel_path`, so it narrows the rows BEFORE the call-return join and before the
 * shape sample's reservoir, where the grouping's join comes too late. A file
 * whose language is unknown (no files row, or a null language) stays: nothing
 * places it outside the scope, and the lexicon already cases such a row as the
 * answer's own. Absent → `TRUE`; empty → `FALSE`.
 */
export function fileLanguagePredicate(languages: readonly string[] | undefined): SqlPredicate {
  if (languages === undefined) return { sql: "TRUE", params: [] };
  if (languages.length === 0) return { sql: "FALSE", params: [] };
  return {
    sql: `rel_path NOT IN (SELECT rel_path FROM cg_symbols_files
                            WHERE language IS NOT NULL AND language NOT IN (${placeholders(languages)}))`,
    params: [...languages],
  };
}

/**
 * An evidence read's file scope: under any of `pathPrefixes`, outside
 * `excludePaths`, and in a file of `languages` (absent = every language).
 */
export function evidenceScopePredicate(
  pathPrefixes: readonly string[] | undefined,
  excludePaths: readonly string[] | undefined,
  languages?: readonly string[],
): SqlPredicate {
  const prefix = pathPrefixPredicate(pathPrefixes);
  // An unscoped narrowing adds nothing, so a read without one keeps its SQL byte-identical.
  const narrowing = [excludedPathsPredicate(excludePaths), fileLanguagePredicate(languages)].filter(
    (p) => p.sql !== "TRUE",
  );
  if (narrowing.length === 0) return prefix;
  const parts = [prefix, ...narrowing];
  return { sql: `(${parts.map((p) => p.sql).join(" AND ")})`, params: parts.flatMap((p) => p.params) };
}

/**
 * The SQL pieces that split an aggregate by file language (`groupByLanguage`):
 * `from` wraps a row source carrying `rel_path` with its `cg_symbols_files`
 * language as `file_language` (null for a file with no files row); `column` is
 * appended to the SELECT, GROUP BY and ORDER BY lists. Not grouping → the source
 * as-is and empty pieces, so the ungrouped read is byte-identical.
 */
interface FileLanguageGrouping {
  from: string;
  column: string;
  order: string;
}

function fileLanguageGrouping(source: string, grouped: boolean | undefined): FileLanguageGrouping {
  if (grouped !== true) return { from: source, column: "", order: "" };
  return {
    from: `(SELECT g.*, f.language AS file_language
              FROM ${source} g
              LEFT JOIN cg_symbols_files f ON f.rel_path = g.rel_path)`,
    column: ", file_language",
    order: ", file_language NULLS LAST",
  };
}

/** {@link ownerKindGrouping}'s pieces: the same shape as a language split. */
type OwnerKindGrouping = FileLanguageGrouping;

/**
 * The SQL pieces behind `groupByOwnerKind` (bd tea-rags-mcp-nfm4h): `from` marks
 * each row with `owner_kind` — its owner's `cg_symbols.symbol_kind` when the row
 * is a `return` and the owner is a `function` / `method`, NULL otherwise — and
 * `column` groups by it. One symbol row per (rel_path, symbol_id), so the join
 * never multiplies a row. Not grouping → `source` as-is and empty pieces, so the
 * plain read is byte-identical.
 */
function ownerKindGrouping(source: string, grouped: boolean | undefined): OwnerKindGrouping {
  if (grouped !== true) return { from: source, column: "", order: "" };
  return {
    from: `(SELECT o.*,
                   CASE WHEN o.kind = 'return' AND s.symbol_kind IN ('function', 'method')
                        THEN s.symbol_kind END AS owner_kind
              FROM ${source} o
              LEFT JOIN cg_symbols s ON s.rel_path = o.rel_path AND s.symbol_id = o.owner_symbol_id)`,
    column: ", owner_kind",
    order: ", owner_kind NULLS LAST",
  };
}

/**
 * The SELECT column behind `countHolders` (bd tea-rags-mcp-bjfa0): the group's
 * distinct owners. Not counting → nothing, so the plain read is byte-identical.
 */
function holdersColumn(counted: boolean | undefined): string {
  return counted === true ? ", count(DISTINCT owner_symbol_id) AS holders" : "";
}

/** The row's `holders` key when the read counted them; nothing otherwise. */
function holdersField(counted: boolean | undefined, row: { holders?: number | string | bigint }): { holders?: number } {
  return counted === true && row.holders !== undefined ? { holders: Number(row.holders) } : {};
}

/** The row's `language` key when the read grouped by it; nothing otherwise. */
function languageField(
  grouped: boolean | undefined,
  row: { file_language?: string | null },
): { language?: string | null } {
  return grouped === true ? { language: row.file_language ?? null } : {};
}

/**
 * The SQL pieces behind `countSameTypeSiblings`: `from` marks each `resolved`
 * row of the asked types with `has_sibling` — its (file, owner, type) holds at
 * least two distinct non-`return` names — computed over the asked types only;
 * `column` sums the marks per group, NULL for a `return` group. Not counting →
 * `resolved` as-is and empty pieces, so the plain read is byte-identical.
 */
function sameTypeSiblingPieces(
  counted: boolean | undefined,
  types: readonly string[],
): { from: string; column: string; params: unknown[] } {
  if (counted !== true) return { from: "resolved", column: "", params: [] };
  const valueName = "CASE WHEN kind <> 'return' THEN name END";
  return {
    from: `(SELECT r.*, (min(${valueName}) OVER owner_type <> max(${valueName}) OVER owner_type) AS has_sibling
              FROM resolved r
             WHERE type_name IN (${placeholders(types)})
            WINDOW owner_type AS (PARTITION BY rel_path, owner_symbol_id, type_name))`,
    column: `, CASE WHEN kind = 'return' THEN NULL
                   ELSE sum(CASE WHEN has_sibling THEN 1 ELSE 0 END) END AS same_type_sibling_n`,
    params: [...types],
  };
}

/** `rel_path` ends in any of `suffixes`; `TRUE` when none is given. `%` / `_` in a suffix match literally. */
function pathSuffixPredicate(suffixes: readonly string[] | undefined): SqlPredicate {
  if (suffixes === undefined || suffixes.length === 0) return { sql: "TRUE", params: [] };
  return {
    sql: `(${suffixes.map(() => "rel_path LIKE ? ESCAPE '\\'").join(" OR ")})`,
    params: suffixes.map((s) => `%${escapeLikeLiteral(s)}`),
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
    // Written explicitly: the column's DEFAULT only covers rows predating 034, and the diff read compares it.
    row.typeMultiplicity ?? "one",
    // A bound local always states whether it unwrapped its call; NULL is kept for
    // rows with no bound call, and for rows written before migration 036.
    row.boundMember === undefined ? null : row.boundCallUnwrapped === true,
    row.returnWrapper ?? null,
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

/** Every `cg_identifiers` column is VARCHAR, INTEGER or BOOLEAN, so a cell is a string, a number, a boolean or NULL. */
function fingerprintCell(cell: unknown): string | null {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "bigint" || typeof cell === "boolean") return cell.toString();
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
 *
 * A target's type is what its callers hold once they consume its wrapper
 * (`Result<T, E>` → `T` through `?`, an async `Promise<T>` → `T` through
 * `await`). A local that states it did NOT consume it (`bound_call_unwrapped =
 * false`) is typed as the target's `return_wrapper` instead, multiplicity one
 * (bd tea-rags-mcp-bjzaf). NULL on either side — a row predating migration 036
 * — reads the target's `T`, as before the columns existed.
 *
 * A wrapper around no nameable value (`Result<(), E>`, an async
 * `Promise<void>`) is a `return` row with `return_wrapper` and NO `type_name`.
 * It feeds `return_types` only: a caller that consumed the wrapper binds
 * nothing and stays untyped, one that did not holds the wrapper. It is never a
 * declaration a read reports — {@link DECLARED_IDENTIFIER_SQL} drops it from
 * `scoped` — so every consumer of `resolved` sees exactly the rows it saw
 * before such rows existed.
 */
export function resolvedIdentifiersCte(scope: SqlPredicate): SqlPredicate {
  return {
    sql: `WITH scoped AS (
        SELECT * FROM cg_identifiers WHERE (${scope.sql}) AND ${DECLARED_IDENTIFIER_SQL}
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
        SELECT rel_path, owner_symbol_id, min(type_name) AS type_name,
               CASE WHEN bool_or(type_multiplicity = 'many') THEN 'many' ELSE 'one' END AS type_multiplicity,
               -- Rows disagreeing on the wrapper keep none: the caller then reads the T.
               CASE WHEN count(DISTINCT COALESCE(return_wrapper, '')) = 1 THEN min(return_wrapper) END AS return_wrapper
          FROM cg_identifiers
         WHERE kind = 'return' AND (type_name IS NOT NULL OR return_wrapper IS NOT NULL)
         GROUP BY rel_path, owner_symbol_id
        -- count(DISTINCT) skips NULL: a wrapper-only row ('Result<(), E>') adds no type,
        -- so typed rows that agree stay typed, and a wrapper-only target counts 0.
        HAVING count(DISTINCT type_name) <= 1
      ),
      call_return AS (
        -- A local that bound the call WITHOUT consuming its wrapper ('load()', not
        -- 'load()?' / 'await load()') holds the wrapper itself, one of it. Only an
        -- explicit false reads so: a row written before migration 036 carries NULL
        -- and keeps the target's T (bd tea-rags-mcp-bjzaf).
        SELECT s.*,
               (s.bound_call_unwrapped = false AND r.return_wrapper IS NOT NULL) AS holds_wrapper,
               r.type_name AS return_type_name, r.type_multiplicity AS return_type_multiplicity,
               r.return_wrapper AS return_wrapper_name
          FROM scoped s
          LEFT JOIN call_targets t
            ON s.type_name IS NULL
           AND t.source_rel_path = s.rel_path
           AND t.source_symbol_id = s.owner_symbol_id
           AND t.call_expression = s.bound_call_expression
          LEFT JOIN return_types r
            ON r.rel_path = t.target_rel_path
           AND r.owner_symbol_id = t.target_symbol_id
      ),
      resolved AS (
        SELECT c.rel_path, c.owner_symbol_id, c.kind, c.name, c.line,
               COALESCE(c.type_name, CASE WHEN c.holds_wrapper THEN c.return_wrapper_name ELSE c.return_type_name END)
                 AS type_name,
               CASE
                 WHEN c.type_name IS NOT NULL THEN c.type_source
                 WHEN c.holds_wrapper OR c.return_type_name IS NOT NULL THEN 'call-return'
               END AS type_source,
               -- A call-return row holds what its target returns; an untyped row, one.
               CASE
                 WHEN c.type_name IS NULL AND c.holds_wrapper THEN 'one'
                 WHEN c.type_name IS NULL AND c.return_type_name IS NOT NULL THEN c.return_type_multiplicity
                 ELSE COALESCE(c.type_multiplicity, 'one')
               END AS type_multiplicity
          FROM call_return c
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

  async aggregateIdentifiersByType(q: IdentifierTypeAggregateQuery): Promise<IdentifierTypeAggregateRow[]> {
    if (q.types.length === 0) return [];
    const cte = resolvedIdentifiersCte(evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages));
    const siblings = sameTypeSiblingPieces(q.countSameTypeSiblings, q.types);
    const ownerKind = ownerKindGrouping(siblings.from, q.groupByOwnerKind);
    const lang = fileLanguageGrouping(ownerKind.from, q.groupByLanguage);
    const multiplicity = q.groupByMultiplicity ? ", type_multiplicity" : "";
    const rows = await this.session.queryAll<{
      type_name: string;
      kind: string;
      name: string;
      type_source: string;
      type_multiplicity?: IdentifierTypeMultiplicity;
      n: number | string;
      example_owner: string;
      file_language?: string | null;
      same_type_sibling_n?: number | string | bigint | null;
      holders?: number | string | bigint;
      owner_kind?: CallableSymbolKind | null;
    }>(
      `${cte.sql}
       SELECT type_name, kind, name, type_source${multiplicity}, count(*) AS n,
              min(owner_symbol_id) AS example_owner${siblings.column}${holdersColumn(q.countHolders)}${ownerKind.column}${lang.column}
         FROM ${lang.from}
        WHERE type_name IN (${placeholders(q.types)})
        GROUP BY type_name, kind, name, type_source${multiplicity}${ownerKind.column}${lang.column}
        ORDER BY n DESC, type_name, kind, name, type_source${multiplicity}${ownerKind.order}${lang.order}`,
      [...cte.params, ...siblings.params, ...q.types],
    );
    return rows.map((r) => ({
      typeName: r.type_name,
      kind: r.kind as IdentifierDeclarationKind,
      name: r.name,
      typeSource: r.type_source as IdentifierTypeSource,
      ...(q.groupByMultiplicity && r.type_multiplicity ? { typeMultiplicity: r.type_multiplicity } : {}),
      n: Number(r.n),
      exampleOwner: r.example_owner,
      ...(r.same_type_sibling_n !== undefined && r.same_type_sibling_n !== null
        ? { sameTypeSiblingN: Number(r.same_type_sibling_n) }
        : {}),
      ...holdersField(q.countHolders, r),
      ...(q.groupByOwnerKind === true && r.kind === "return" ? { ownerKind: r.owner_kind ?? null } : {}),
      ...languageField(q.groupByLanguage, r),
    }));
  }

  async countIdentifiers(q: IdentifierTypeScopeQuery): Promise<number> {
    if (q.types.length === 0) return 0;
    const cte = resolvedIdentifiersCte(evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages));
    const rows = await this.session.queryAll<{ n: number | string }>(
      `${cte.sql}
       SELECT count(*) AS n FROM resolved WHERE type_name IN (${placeholders(q.types)})`,
      [...cte.params, ...q.types],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async aggregateIdentifiersByCallee(q: IdentifierCalleeScopeQuery): Promise<IdentifierCalleeAggregateRow[]> {
    if (q.callees.length === 0) return [];
    const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
    const calleeParams: unknown[] = [];
    const calleeSql = q.callees
      .map((callee) => {
        calleeParams.push(callee.member);
        if (callee.receiver === undefined) return "(bound_member = ?)";
        calleeParams.push(callee.receiver);
        return "(bound_member = ? AND bound_receiver = ?)";
      })
      .join(" OR ");
    const lang = fileLanguageGrouping("cg_identifiers", q.groupByLanguage);
    const rows = await this.session.queryAll<{
      bound_member: string;
      bound_receiver: string | null;
      kind: string;
      name: string;
      type_name: string | null;
      n: number | string;
      example_owner: string;
      file_language?: string | null;
      holders?: number | string | bigint;
    }>(
      `SELECT bound_member, bound_receiver, kind, name, type_name, count(*) AS n,
              min(owner_symbol_id) AS example_owner${holdersColumn(q.countHolders)}${lang.column}
         FROM ${lang.from}
        WHERE ${scope.sql} AND (${calleeSql})
        GROUP BY bound_member, bound_receiver, kind, name, type_name${lang.column}
        ORDER BY n DESC, bound_member, bound_receiver NULLS FIRST, kind, name, type_name NULLS FIRST${lang.order}`,
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
      ...holdersField(q.countHolders, r),
      ...languageField(q.groupByLanguage, r),
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

  async identifierNameTypes(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<IdentifierNameTypeRow[]> {
    const out: IdentifierNameTypeRow[] = [];
    const scope = evidenceScopePredicate(undefined, excludePaths, languages);
    for (const chunk of chunked([...new Set(names)])) {
      const cte = resolvedIdentifiersCte({
        sql: `name IN (${placeholders(chunk)}) AND ${scope.sql}`,
        params: [...chunk, ...scope.params],
      });
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
    const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
    for (const chunk of chunked([...new Set(q.names)])) {
      const cte = resolvedIdentifiersCte({
        sql: `name IN (${placeholders(chunk)}) AND ${scope.sql}`,
        params: [...chunk, ...scope.params],
      });
      const lang = fileLanguageGrouping("resolved", q.groupByLanguage);
      const rows = await this.session.queryAll<{
        name: string;
        kind: string;
        type_name: string | null;
        n: number | string;
        example_owner: string;
        file_language?: string | null;
        holders?: number | string | bigint;
      }>(
        `${cte.sql}
         SELECT name, kind, type_name, count(*) AS n,
                min(owner_symbol_id) AS example_owner${holdersColumn(q.countHolders)}${lang.column}
           FROM ${lang.from}
          GROUP BY name, kind, type_name${lang.column}
          ORDER BY name, kind, type_name NULLS LAST${lang.order}`,
        cte.params,
      );
      for (const r of rows) {
        out.push({
          name: r.name,
          kind: r.kind as IdentifierDeclarationKind,
          typeName: r.type_name,
          n: Number(r.n),
          exampleOwner: r.example_owner,
          ...holdersField(q.countHolders, r),
          ...languageField(q.groupByLanguage, r),
        });
      }
    }
    return out;
  }

  async identifierLanguageCounts(q: IdentifierLanguageCountQuery): Promise<IdentifierLanguageCountRow[]> {
    const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
    const suffix = pathSuffixPredicate(q.pathSuffixes);
    const rows = await this.session.queryAll<{ language: string | null; n: number | string }>(
      `SELECT f.language, count(*) AS n
         FROM (SELECT rel_path FROM cg_identifiers
                WHERE ${scope.sql} AND ${suffix.sql} AND ${DECLARED_IDENTIFIER_SQL}) i
         LEFT JOIN cg_symbols_files f ON f.rel_path = i.rel_path
        GROUP BY f.language
        ORDER BY n DESC, f.language NULLS LAST`,
      [...scope.params, ...suffix.params],
    );
    return rows.map((r) => ({ language: r.language, n: Number(r.n) }));
  }

  async sampleIdentifierShapes(q: IdentifierShapeSampleQuery): Promise<IdentifierShapeSampleRow[]> {
    // The language scope is in the WHERE the reservoir samples from: a post-filter would thin the sample.
    const scope = evidenceScopePredicate(q.pathPrefixes, q.excludePaths, q.languages);
    // The reservoir size is inlined: DuckDB takes no bind parameter there. It is
    // coerced to a positive integer first, so no caller value reaches the SQL text.
    const limit = Math.max(1, Math.floor(Number(q.limit) || 1));
    // The file language joins AFTER sampling, so the join meets only the sampled rows.
    const sampled = `(
           SELECT * FROM (
             SELECT kind, name, type_name, bound_member, bound_receiver${q.groupByLanguage === true ? ", rel_path" : ""}
               FROM cg_identifiers
              WHERE ${scope.sql} AND (type_name IS NOT NULL OR bound_member IS NOT NULL)
           ) USING SAMPLE reservoir(${limit} ROWS) REPEATABLE (${SHAPE_SAMPLE_SEED})
         )`;
    const lang = fileLanguageGrouping(sampled, q.groupByLanguage);
    const rows = await this.session.queryAll<{
      kind: string;
      name: string;
      type_name: string | null;
      bound_member: string | null;
      bound_receiver: string | null;
      n: number | string;
      file_language?: string | null;
    }>(
      `SELECT kind, name, type_name, bound_member, bound_receiver, count(*) AS n${lang.column}
         FROM ${lang.from}
        GROUP BY kind, name, type_name, bound_member, bound_receiver${lang.column}
        ORDER BY n DESC, kind, name${lang.order}`,
      scope.params,
    );
    return rows.map((r) => ({
      kind: r.kind as IdentifierDeclarationKind,
      name: r.name,
      typeName: r.type_name,
      boundMember: r.bound_member,
      boundReceiver: r.bound_receiver,
      n: Number(r.n),
      ...languageField(q.groupByLanguage, r),
    }));
  }

  /** `languages` scopes by the language of the file declaring the symbol (`cg_symbols.rel_path`). */
  async existingSymbolShortNames(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<string[]> {
    const out: string[] = [];
    const scope = evidenceScopePredicate(undefined, excludePaths, languages);
    for (const chunk of chunked([...new Set(names)])) {
      const rows = await this.session.queryAll<{ short_name: string }>(
        `SELECT DISTINCT short_name FROM cg_symbols
          WHERE short_name IN (${placeholders(chunk)}) AND ${scope.sql}
          ORDER BY short_name`,
        [...chunk, ...scope.params],
      );
      for (const r of rows) out.push(r.short_name);
    }
    return out;
  }

  /**
   * Head-word candidates of the verb lexicon (spec §D4a), one statement: the
   * head is the leading lowercase run before `_` or a capital, its tail the
   * rest lowercased with `_` and trailing `!` / `?` dropped (`update_user!`,
   * `updateUser` → `update` + `user`). `lastHolders` is read only for the heads
   * that clear `minTails`, from names of two or more words. `valueCompounds` is
   * read for the same heads: the distinct compounds (`short_name` without
   * trailing `!` / `?` / `=`) that equal a value's name ({@link
   * methodValueScopePredicate}, leading `@` / `@@` dropped), matched within the
   * file language when grouping.
   */
  async readMethodHeadWords(q: MethodHeadWordQuery): Promise<MethodHeadWordRow[]> {
    const scope = methodNameScopePredicate(q);
    const valueScope = methodValueScopePredicate(q);
    const lang = fileLanguageGrouping("cg_symbols", q.groupByLanguage);
    const valueLang = fileLanguageGrouping(
      `(SELECT rel_path, ${IDENTIFIER_VALUE_NAME_SQL} AS value_name FROM cg_identifiers WHERE ${valueScope.sql})`,
      q.groupByLanguage,
    );
    const grouped = q.groupByLanguage === true;
    const sameLanguage = (left: string, right: string): string =>
      grouped ? ` AND ${left}.file_language IS NOT DISTINCT FROM ${right}.file_language` : "";
    const rows = await this.session.queryAll<{
      head: string;
      head_holders: number | string | bigint;
      head_tails: number | string | bigint;
      last_holders: number | string | bigint;
      value_compounds: number | string | bigint;
      file_language?: string | null;
    }>(
      `WITH named AS (
         SELECT symbol_id, short_name${lang.column}
           FROM ${lang.from}
          WHERE ${scope.sql}
       ),
       headed AS (
         SELECT symbol_id${lang.column}, ${METHOD_HEAD_SQL} AS head, ${METHOD_TAIL_SQL} AS tail,
                ${METHOD_COMPOUND_SQL} AS compound
           FROM named
       ),
       heads AS (
         SELECT head${lang.column}, count(DISTINCT symbol_id) AS head_holders, count(DISTINCT tail) AS head_tails
           FROM headed
          WHERE head <> '' AND tail <> ''
          GROUP BY head${lang.column}
         HAVING count(DISTINCT tail) >= ?
       ),
       lasts AS (
         SELECT last_word${lang.column}, count(DISTINCT symbol_id) AS last_holders
           FROM (SELECT symbol_id${lang.column}, ${METHOD_LAST_WORD_SQL} AS last_word
                   FROM named
                  WHERE regexp_matches(${METHOD_UNMARKED_SQL}, '[a-z0-9][_A-Z]'))
          WHERE last_word IN (SELECT head FROM heads)
          GROUP BY last_word${lang.column}
       ),
       valued AS (
         SELECT DISTINCT value_name${lang.column}
           FROM ${valueLang.from}
       ),
       compounds AS (
         SELECT d.head${grouped ? ", d.file_language" : ""}, count(DISTINCT d.compound) AS value_compounds
           FROM headed d
           JOIN valued v ON v.value_name = d.compound${sameLanguage("v", "d")}
          WHERE d.head <> '' AND d.tail <> '' AND d.head IN (SELECT head FROM heads)
          GROUP BY d.head${grouped ? ", d.file_language" : ""}
       )
       SELECT h.head, h.head_holders, h.head_tails, coalesce(l.last_holders, 0) AS last_holders,
              coalesce(c.value_compounds, 0) AS value_compounds${grouped ? ", h.file_language" : ""}
         FROM heads h
         LEFT JOIN lasts l
           ON l.last_word = h.head${sameLanguage("l", "h")}
         LEFT JOIN compounds c
           ON c.head = h.head${sameLanguage("c", "h")}
        ORDER BY h.head_holders DESC, h.head${grouped ? ", h.file_language NULLS LAST" : ""}`,
      [...scope.params, q.minTails, ...valueScope.params],
    );
    return rows.map((r) => ({
      head: r.head,
      headHolders: Number(r.head_holders),
      headTails: Number(r.head_tails),
      lastHolders: Number(r.last_holders),
      valueCompounds: Number(r.value_compounds),
      ...languageField(q.groupByLanguage, r),
    }));
  }

  /**
   * The (tail, head) pairs of `q.heads` over the tails two or more of them open
   * across the read — a tail one head owns contests nothing and is not read.
   * `name` is the pair's most-held spelling, ties by name.
   */
  async readMethodTailVerbs(q: MethodTailVerbQuery): Promise<MethodTailVerbRow[]> {
    if (q.heads.length === 0) return [];
    const scope = methodNameScopePredicate(q);
    const lang = fileLanguageGrouping("cg_symbols", q.groupByLanguage);
    const rows = await this.session.queryAll<{
      tail: string;
      head: string;
      holders: number | string | bigint;
      name: string;
      file_language?: string | null;
    }>(
      `WITH verbed AS (
         SELECT *
           FROM (SELECT symbol_id, short_name${lang.column}, ${METHOD_HEAD_SQL} AS head, ${METHOD_TAIL_SQL} AS tail
                   FROM ${lang.from}
                  WHERE ${scope.sql})
          WHERE head IN (${placeholders(q.heads)}) AND tail <> ''
       ),
       contested AS (
         SELECT tail FROM verbed GROUP BY tail HAVING count(DISTINCT head) > 1
       ),
       spelled AS (
         SELECT tail, head${lang.column}, short_name, count(DISTINCT symbol_id) AS n
           FROM verbed
          WHERE tail IN (SELECT tail FROM contested)
          GROUP BY tail, head${lang.column}, short_name
       )
       SELECT tail, head${lang.column}, sum(n) AS holders, first(short_name ORDER BY n DESC, short_name) AS name
         FROM spelled
        GROUP BY tail, head${lang.column}
        ORDER BY tail, holders DESC, head${lang.order}`,
      [...scope.params, ...q.heads],
    );
    return rows.map((r) => ({
      tail: r.tail,
      head: r.head,
      holders: Number(r.holders),
      name: r.name,
      ...languageField(q.groupByLanguage, r),
    }));
  }

  async readMethodNamesMatching(q: MethodNamePatternQuery): Promise<MethodNameRow[]> {
    if (q.patterns.length === 0) return [];
    const scope = methodNameScopePredicate(q);
    const lang = fileLanguageGrouping("cg_symbols", q.groupByLanguage);
    const rows = await this.session.queryAll<{
      short_name: string;
      holders: number | string | bigint;
      file_language?: string | null;
    }>(
      `SELECT short_name, count(DISTINCT symbol_id) AS holders${lang.column}
         FROM ${lang.from}
        WHERE ${scope.sql} AND (${q.patterns.map(() => "regexp_matches(short_name, ?)").join(" OR ")})
        GROUP BY short_name${lang.column}
        ORDER BY holders DESC, short_name${lang.order}`,
      [...scope.params, ...q.patterns],
    );
    return rows.map((r) => ({
      shortName: r.short_name,
      holders: Number(r.holders),
      ...languageField(q.groupByLanguage, r),
    }));
  }
}
