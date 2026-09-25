/**
 * The project-wide naming ontology audit over `cg_identifiers`
 * (bd tea-rags-mcp-4p3sb.20) — the reads behind `get_ontology_report`.
 *
 * Every section aggregates in DuckDB: one query per section over a shared CTE
 * chain, one row per finding, names and types folded into `list(...)` columns.
 * Nothing scrolls the table into JS — a large project holds ~10^5–10^6 rows.
 *
 * The CTE chain, in order:
 *   - `resolved` — {@link resolvedIdentifiersCte}: the persisted type, or the
 *     `call-return` type of a row bound to a single-target exact call. Narrowed
 *     BEFORE the join by the language's file extensions;
 *   - `concept_all` — rows under the path scope whose effective type names a
 *     concept: not a
 *     non-concept type of the row's language, not a single capital letter;
 *     value kinds only (`param`, `local`, `field` — a `return` row's name is a
 *     method name, not a value name); a name of more than one character; not
 *     an unused marker — a `param` / `local` named `_` + letter (`_ctx`), the
 *     TS / Ruby / Rust / Python convention for a binding the body ignores.
 *     Fields keep a leading `_` (Python `_private` is a real name), and a
 *     dunder (`__init__`) is no marker;
 *   - `generic` — names bound to many types none of which dominates. Data
 *     derived, so `result` / `data` / `item` drop out without a hardcoded list.
 *     Judged over the same scoped rows as every section: the summary reports
 *     the names generic IN the scope, and a name generic elsewhere but bound to
 *     one type here is evidence here. Generic by type count alone: the summary
 *     hands each name over with its types, and the ops layer — which owns the
 *     naming-shape classifier — drops the types the name spells (a type family's
 *     role word, `form` over `*Form`) before it reports the name as generic;
 *   - `evidence` — `concept_all` with the generic names removed.
 *
 * `name-inferred` types are never evidence: they are a query-time statistic of
 * the naming lexicon that is neither persisted nor computed here, so the audit
 * cannot confirm itself.
 *
 * Numeric thresholds are inlined as validated literals (the session binds every
 * parameter as VARCHAR); every string is bound.
 */

import type {
  IdentifierDeclarationKind,
  IdentifierTypeSource,
  OntologyCollisionRow,
  OntologyCollisionRule,
  OntologyEvidenceCounts,
  OntologyGenericNameRow,
  OntologyHomonymRow,
  OntologyLocationRow,
  OntologyNameCountRow,
  OntologyReportQuery,
  OntologyReportRows,
  OntologyTypeGroupRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { pathPrefixPredicate, resolvedIdentifiersCte, type SqlPredicate } from "./identifier-store.js";

/** Exhaustive over {@link IdentifierTypeSource}: a new source is a compile error here, not a silent zero. */
const TYPE_SOURCE_SET: Record<IdentifierTypeSource, true> = {
  annotation: true,
  constructor: true,
  binding: true,
  "field-type": true,
  "return-type": true,
  finder: true,
  "call-return": true,
};
const TYPE_SOURCES = Object.keys(TYPE_SOURCE_SET) as IdentifierTypeSource[];

/** Lowercased file extension of `rel_path`, dot included (`.rb`); empty when none. */
const EXTENSION_SQL = `lower(regexp_extract(rel_path, '\\.[^./]+$'))`;
/** The name without a storage sigil (`@`, `@@`, `$`). */
const BARE_NAME_SQL = `regexp_replace(name, '^(@@|@|\\$)', '')`;
/** A single `_` then a letter: the unused-binding marker (`_ctx`); a dunder (`__init__`) does not match. */
const UNUSED_MARKER_SQL = `regexp_matches(name, '^_[A-Za-z]')`;
/**
 * A short name in capitals, digits and `_` only, with at least two letters:
 * `GROUP`, `MAX_SIZE`, and equally the acronym class `URI`. `cg_symbols`
 * records no symbol kind, so spelling alone cannot tell a value constant from
 * an acronym type — {@link DuckDbOntologyReportStore#readCollisions} settles it
 * structurally. The SCREAMING_SNAKE rule of the identifier-row builder
 * (`isValueConstantName`, trajectory codegraph) needs an underscore and so
 * misses the single-word constant; it is not importable here either.
 */
const ALL_CAPS_SQL = (column: string) =>
  `(regexp_full_match(${column}, '[A-Z0-9_]+') AND length(regexp_replace(${column}, '[^A-Z]', '', 'g')) >= 2)`;
/** Deterministic example-row order: first file, first line, first owner. */
const EXAMPLE_KEY_SQL = `rel_path || ':' || lpad(CAST(line AS VARCHAR), 10, '0') || ':' || owner_symbol_id`;
const EXAMPLE_COLUMNS_SQL = `arg_min(rel_path, ${EXAMPLE_KEY_SQL}) AS ex_path,
         arg_min(line, ${EXAMPLE_KEY_SQL}) AS ex_line,
         arg_min(owner_symbol_id, ${EXAMPLE_KEY_SQL}) AS ex_owner`;
/** Rows per type source, one column each, plus the untyped rows. */
const EVIDENCE_COLUMNS_SQL = [
  ...TYPE_SOURCES.map((source, i) => `CAST(count(*) FILTER (WHERE type_source = '${source}') AS INTEGER) AS src_${i}`),
  `CAST(count(*) FILTER (WHERE type_name IS NULL) AS INTEGER) AS src_untyped`,
].join(",\n         ");

/** A finite number as a SQL literal; the thresholds are policy values, never user text. */
function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`ontology report: non-finite threshold ${value}`);
  return String(value);
}

function int(value: number): string {
  return num(Math.max(0, Math.floor(value)));
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function extensionPredicate(extensions: readonly string[] | undefined): SqlPredicate {
  if (extensions === undefined || extensions.length === 0) return { sql: "TRUE", params: [] };
  return { sql: `${EXTENSION_SQL} IN (${placeholders(extensions)})`, params: [...extensions] };
}

function nonConceptPredicate(q: OntologyReportQuery): SqlPredicate {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const group of q.nonConceptTypes) {
    if (group.extensions.length === 0 || group.typeNames.length === 0) continue;
    parts.push(
      `(${EXTENSION_SQL} IN (${placeholders(group.extensions)}) AND type_name IN (${placeholders(group.typeNames)}))`,
    );
    params.push(...group.extensions, ...group.typeNames);
  }
  return parts.length === 0 ? { sql: "FALSE", params: [] } : { sql: parts.join(" OR "), params };
}

/** The shared CTE chain — see the module doc. Ends with `evidence`; `resolved` and `generic` stay addressable. */
function ontologyBaseCte(q: OntologyReportQuery): SqlPredicate {
  const resolved = resolvedIdentifiersCte(extensionPredicate(q.extensions));
  const nonConcept = nonConceptPredicate(q);
  const scope = pathPrefixPredicate(q.pathPrefixes);
  const t = q.thresholds;
  return {
    sql: `${resolved.sql},
      concept_all AS (
        SELECT rel_path, owner_symbol_id, kind, name, type_name, type_source, line
          FROM resolved
         WHERE type_name IS NOT NULL
           AND kind IN ('param', 'local', 'field')
           AND NOT regexp_full_match(type_name, '[A-Z]?')
           AND length(${BARE_NAME_SQL}) > 1
           AND NOT (kind IN ('param', 'local') AND ${UNUSED_MARKER_SQL})
           AND NOT (${nonConcept.sql})
           AND ${scope.sql}
      ),
      name_types AS (
        SELECT name, type_name, count(*) AS n FROM concept_all GROUP BY name, type_name
      ),
      generic AS (
        SELECT name, count(*) AS type_count, sum(n) AS n
          FROM name_types
         GROUP BY name
        HAVING count(*) >= ${int(t.genericMinTypes)} AND max(n) < ${num(t.genericMaxTopTypeShare)} * sum(n)
      ),
      evidence AS (
        SELECT * FROM concept_all
         WHERE name NOT IN (SELECT name FROM generic)
      )`,
    params: [...resolved.params, ...nonConcept.params, ...scope.params],
  };
}

type Row = Record<string, unknown>;

function count(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function readEvidence(row: Row): OntologyEvidenceCounts {
  const out: OntologyEvidenceCounts = {};
  TYPE_SOURCES.forEach((source, i) => {
    const n = count(row[`src_${i}`]);
    if (n > 0) out[source] = n;
  });
  const untyped = count(row.src_untyped);
  if (untyped > 0) out.untyped = untyped;
  return out;
}

function readLocation(row: Row, prefix: "ex_" | "" = "ex_"): OntologyLocationRow {
  if (prefix === "") {
    return { relPath: row.relPath as string, line: count(row.line), ownerSymbolId: row.ownerSymbolId as string };
  }
  return { relPath: row.ex_path as string, line: count(row.ex_line), ownerSymbolId: row.ex_owner as string };
}

/** A `list({name, n, relPath, line, ownerSymbolId})` column. */
function readNameList(value: unknown): OntologyNameCountRow[] {
  return ((value as Row[] | null) ?? []).map((item) => ({
    name: item.name as string,
    n: count(item.n),
    example: readLocation(item, ""),
  }));
}

/** Which (type, kind) groups a type-group read keeps and how it ranks them. */
interface TypeGroupSelection {
  where: string;
  score: string;
}

export class DuckDbOntologyReportStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async readOntologyReport(q: OntologyReportQuery): Promise<OntologyReportRows> {
    const sections = new Set(q.sections);
    const totals = await this.readTotals();
    const summary = await this.readSummary(q);
    const t = q.thresholds;
    const confidence = `least(1.0, power(total / ${num(t.confidenceSupport)}, 2))`;
    return {
      totals,
      ...summary,
      ...(sections.has("synonyms")
        ? {
            synonyms: await this.readTypeGroups(q, {
              where: `top_n < ${num(t.synonymDominantShareCeiling)} * total`,
              score: `(1 - top_n / total) * ${confidence}`,
            }),
          }
        : {}),
      ...(sections.has("homonyms") ? { homonyms: await this.readHomonyms(q) } : {}),
      ...(sections.has("outliers")
        ? {
            outlierGroups: await this.readTypeGroups(q, {
              where: `top_n >= ${num(t.outlierMinDominantShare)} * total`,
              score: `(top_n / total) * ${confidence}`,
            }),
          }
        : {}),
      ...(sections.has("collisions") ? { collisions: await this.readCollisions(q) } : {}),
    };
  }

  private async readTotals(): Promise<OntologyReportRows["totals"]> {
    const [row] = await this.session.queryAll<Row>(
      `SELECT (SELECT count(*) FROM cg_identifiers) AS identifier_rows,
              (SELECT count(*) FROM cg_symbols) AS symbol_rows`,
    );
    return { identifierRows: count(row?.identifier_rows), symbolRows: count(row?.symbol_rows) };
  }

  private async readSummary(
    q: OntologyReportQuery,
  ): Promise<Pick<OntologyReportRows, "evidenceRows" | "genericNameCount" | "genericNames">> {
    const base = ontologyBaseCte(q);
    const [row] = await this.session.queryAll<Row>(
      `${base.sql},
       generic_types AS (
         SELECT name, type_name, count(*) AS n, arg_min(rel_path, ${EXAMPLE_KEY_SQL}) AS ex_path
           FROM concept_all
          WHERE name IN (SELECT name FROM generic)
          GROUP BY name, type_name
       ),
       generic_pool AS (
         SELECT g.name, g.type_count, g.n,
                list({'typeName': t.type_name, 'n': CAST(t.n AS INTEGER), 'relPath': t.ex_path}
                     ORDER BY t.n DESC, t.type_name) AS types
           FROM generic g JOIN generic_types t USING (name)
          GROUP BY g.name, g.type_count, g.n
       )
       SELECT (SELECT count(*) FROM evidence) AS evidence_rows,
              (SELECT count(*) FROM generic) AS generic_count,
              (SELECT list({'name': name, 'typeCount': CAST(type_count AS INTEGER), 'n': CAST(n AS INTEGER),
                            'types': types} ORDER BY n DESC, name)
                 FROM generic_pool) AS generic_names`,
      base.params,
    );
    const genericNames: OntologyGenericNameRow[] = ((row?.generic_names as Row[] | null) ?? []).map((g) => ({
      name: g.name as string,
      typeCount: count(g.typeCount),
      n: count(g.n),
      types: ((g.types as Row[] | null) ?? []).map((t) => ({
        typeName: t.typeName as string,
        n: count(t.n),
        relPath: t.relPath as string,
      })),
    }));
    return {
      evidenceRows: count(row?.evidence_rows),
      genericNameCount: count(row?.generic_count),
      genericNames,
    };
  }

  /** (type, kind) groups of two or more names, ranked by `selection.score`, capped at `groupPool`. */
  private async readTypeGroups(q: OntologyReportQuery, selection: TypeGroupSelection): Promise<OntologyTypeGroupRow[]> {
    const base = ontologyBaseCte(q);
    const t = q.thresholds;
    const rows = await this.session.queryAll<Row>(
      `${base.sql},
       group_names AS (
         SELECT type_name, kind, name, count(*) AS n,
                ${EXAMPLE_COLUMNS_SQL}
           FROM evidence
          GROUP BY type_name, kind, name
       ),
       groups AS (
         SELECT type_name, kind, sum(n) AS total, count(*) AS distinct_names, max(n) AS top_n,
                sum(n * ln(n)) AS n_log_n,
                list({'name': name, 'n': CAST(n AS INTEGER), 'relPath': ex_path, 'line': ex_line,
                      'ownerSymbolId': ex_owner} ORDER BY n DESC, name) AS names
           FROM group_names
          GROUP BY type_name, kind
       ),
       picked AS (
         SELECT type_name, kind, total, distinct_names, names,
                top_n / total AS dominant_share,
                (ln(total) - n_log_n / total) / ln(distinct_names) AS entropy,
                ${selection.score} AS score
           FROM groups
          WHERE total >= ${int(t.minSupport)} AND distinct_names >= 2 AND ${selection.where}
          ORDER BY score DESC, total DESC, type_name, kind
          LIMIT ${int(t.groupPool)}
       ),
       sources AS (
         SELECT type_name, kind, ${EVIDENCE_COLUMNS_SQL}
           FROM evidence JOIN picked USING (type_name, kind)
          GROUP BY type_name, kind
       )
       SELECT p.type_name, p.kind, CAST(p.total AS INTEGER) AS n, CAST(p.distinct_names AS INTEGER) AS distinct_names,
              p.dominant_share, p.entropy, list_slice(p.names, 1, ${int(t.namesPerItem)}) AS names,
              s.* EXCLUDE (type_name, kind)
         FROM picked p JOIN sources s USING (type_name, kind)
        ORDER BY p.score DESC, p.total DESC, p.type_name, p.kind`,
      base.params,
    );
    return rows.map((r) => ({
      typeName: r.type_name as string,
      kind: r.kind as Exclude<IdentifierDeclarationKind, "return">,
      n: count(r.n),
      distinctNames: count(r.distinct_names),
      dominantShare: Number(r.dominant_share),
      entropy: Number(r.entropy),
      names: readNameList(r.names),
      evidence: readEvidence(r),
    }));
  }

  /**
   * Names bound to two or more supported concept types, ranked by how evenly
   * they split. A candidate POOL (`groupPool`, every qualifying type uncapped):
   * the ops layer drops type-family role words and merged spellings, then caps
   * at `limit` and `namesPerItem`.
   */
  private async readHomonyms(q: OntologyReportQuery): Promise<OntologyHomonymRow[]> {
    const base = ontologyBaseCte(q);
    const t = q.thresholds;
    const rows = await this.session.queryAll<Row>(
      `${base.sql},
       name_type_rows AS (
         SELECT name, type_name, count(*) AS n,
                ${EXAMPLE_COLUMNS_SQL}
           FROM evidence
          GROUP BY name, type_name
       ),
       name_totals AS (
         SELECT name, sum(n) AS total, max(n) AS top_n FROM name_type_rows GROUP BY name
       ),
       picked AS (
         SELECT r.name, t.total, t.top_n,
                list({'typeName': r.type_name, 'n': CAST(r.n AS INTEGER), 'relPath': r.ex_path, 'line': r.ex_line,
                      'ownerSymbolId': r.ex_owner} ORDER BY r.n DESC, r.type_name) AS types,
                (1 - t.top_n / t.total) * least(1.0, power(t.total / ${num(t.confidenceSupport)}, 2)) AS score
           FROM name_type_rows r JOIN name_totals t USING (name)
          WHERE r.n >= ${int(t.homonymMinTypeRows)} AND r.n >= ${num(t.homonymMinTypeShare)} * t.total
          GROUP BY r.name, t.total, t.top_n
         HAVING count(*) >= 2 AND t.total >= ${int(t.minSupport)}
          ORDER BY score DESC, t.total DESC, r.name
          LIMIT ${int(t.groupPool)}
       ),
       sources AS (
         SELECT name, ${EVIDENCE_COLUMNS_SQL}
           FROM evidence JOIN picked USING (name)
          GROUP BY name
       )
       SELECT p.name, CAST(p.total AS INTEGER) AS n, p.top_n / p.total AS top_type_share,
              p.types,
              s.* EXCLUDE (name)
         FROM picked p JOIN sources s USING (name)
        ORDER BY p.score DESC, p.total DESC, p.name`,
      base.params,
    );
    return rows.map((r) => ({
      name: r.name as string,
      n: count(r.n),
      topTypeShare: Number(r.top_type_share),
      types: ((r.types as Row[] | null) ?? []).map((item) => ({
        typeName: item.typeName as string,
        n: count(item.n),
        example: readLocation(item, ""),
      })),
      evidence: readEvidence(r),
    }));
  }

  /**
   * Two collision rules, each capped at `limit`:
   *   - `namesOtherType` — a concept-typed value whose name, sigil and `_`
   *     dropped and case folded, equals a type-like symbol short name
   *     (capitalised, not a method id) that is NOT its own type's last segment
   *     and not an ancestor or descendant of it (`cg_symbols_inheritance`, by
   *     last segment): a `Payment` called `invoice` while class `Invoice` exists.
   *     An all-caps short name (`GROUP`) is a value constant, not a type, unless
   *     the graph shows it is one — it owns a member symbol (`URI.parse`) or
   *     takes part in an inheritance edge — since `cg_symbols` records no kind;
   *   - `shadowsMethod` — a local named like an instance method of its owner's
   *     class (`Report#render` declaring `title` beside `Report#title`); typed
   *     or not, since the collision is with the name, not the value.
   */
  private async readCollisions(q: OntologyReportQuery): Promise<OntologyCollisionRow[]> {
    const base = ontologyBaseCte(q);
    const scope = pathPrefixPredicate(q.pathPrefixes);
    const nameKey = (column: string) => `lower(replace(regexp_replace(${column}, '^(@@|@|\\$)', ''), '_', ''))`;
    const lastSegment = (column: string) => `regexp_extract(${column}, '([^:.#]+)$', 1)`;
    const rows = await this.session.queryAll<Row>(
      `${base.sql},
       symbol_owners AS (
         SELECT DISTINCT regexp_extract(symbol_id, '^(.+)(#|\\.|::)[^#.:]+$', 1) AS owner_id FROM cg_symbols
       ),
       type_symbols AS (
         SELECT lower(s.short_name) AS key, min(s.short_name) AS short_name
           FROM cg_symbols s
          WHERE regexp_matches(s.short_name, '^[A-Z]') AND NOT contains(s.symbol_id, '#')
            AND NOT (${ALL_CAPS_SQL("s.short_name")}
                     AND s.symbol_id NOT IN (SELECT owner_id FROM symbol_owners)
                     AND s.fq_name NOT IN (SELECT source_fq_name FROM cg_symbols_inheritance)
                     AND s.fq_name NOT IN (SELECT ancestor_fq_name FROM cg_symbols_inheritance))
          GROUP BY lower(s.short_name)
       ),
       names_other_type AS (
         SELECT 'namesOtherType' AS rule, e.name, ts.short_name AS symbol, e.type_name,
                e.rel_path, e.line, e.owner_symbol_id, e.type_source
           FROM evidence e JOIN type_symbols ts ON ts.key = ${nameKey("e.name")}
          WHERE lower(${lastSegment("e.type_name")}) <> ts.key
            AND NOT EXISTS (
              SELECT 1 FROM cg_symbols_inheritance h
               WHERE (lower(${lastSegment("h.source_fq_name")}) = lower(${lastSegment("e.type_name")})
                      AND lower(${lastSegment("h.ancestor_fq_name")}) = ts.key)
                  OR (lower(${lastSegment("h.source_fq_name")}) = ts.key
                      AND lower(${lastSegment("h.ancestor_fq_name")}) = lower(${lastSegment("e.type_name")}))
            )
       ),
       scoped_locals AS (
         SELECT *, regexp_extract(owner_symbol_id, '^(.+)[#.][^#.]+$', 1) AS owner_class
           FROM resolved
          WHERE kind = 'local'
            AND ${scope.sql}
            AND length(${BARE_NAME_SQL}) > 1
            AND name NOT IN (SELECT name FROM generic)
       ),
       shadows_method AS (
         SELECT 'shadowsMethod' AS rule, l.name, l.owner_class || '#' || l.name AS symbol, NULL AS type_name,
                l.rel_path, l.line, l.owner_symbol_id, l.type_source
           FROM scoped_locals l
          WHERE l.owner_class <> ''
            AND l.owner_class || '#' || l.name <> l.owner_symbol_id
            AND EXISTS (SELECT 1 FROM cg_symbols s WHERE s.symbol_id = l.owner_class || '#' || l.name)
       ),
       collided AS (
         SELECT * FROM names_other_type UNION ALL SELECT * FROM shadows_method
       ),
       grouped AS (
         SELECT rule, name, symbol, type_name, count(*) AS n,
                ${EXAMPLE_COLUMNS_SQL},
                ${EVIDENCE_COLUMNS_SQL.replace("type_name IS NULL", "rule = 'shadowsMethod' AND type_source IS NULL")}
           FROM collided
          GROUP BY rule, name, symbol, type_name
       ),
       ranked AS (
         SELECT *, row_number() OVER (PARTITION BY rule ORDER BY n DESC, name, symbol, type_name) AS rn FROM grouped
       )
       SELECT * EXCLUDE (rn) FROM ranked
        WHERE rn <= ${int(q.limit)}
        ORDER BY CASE rule WHEN 'namesOtherType' THEN 0 ELSE 1 END, rn`,
      [...base.params, ...scope.params],
    );
    return rows.map((r) => ({
      rule: r.rule as OntologyCollisionRule,
      name: r.name as string,
      symbol: r.symbol as string,
      ...(r.type_name ? { typeName: r.type_name as string } : {}),
      n: count(r.n),
      example: readLocation(r),
      evidence: readEvidence(r),
    }));
  }
}
