/**
 * The project-wide naming ontology audit over `cg_identifiers`
 * (bd tea-rags-mcp-4p3sb.20) — the reads behind `get_ontology_report`.
 *
 * Two reads, one per phase of a report. The summary read
 * ({@link DuckDbOntologyReportStore#readOntologyReportSummary}) returns the
 * totals and the generic-name CANDIDATES; the caller judges them and passes the
 * names it keeps to the sections read
 * ({@link DuckDbOntologyReportStore#readOntologyReportSections}), which drops
 * exactly those names from its evidence. The store holds no naming-shape
 * classifier, so it cannot judge a candidate, and the sections must exclude the
 * judged set, not the candidates: `form` over 729 `*Form` classes is a
 * candidate, a role word once judged, and its rows are evidence.
 *
 * Every section aggregates in DuckDB: one query per section over a shared CTE
 * chain, one row per finding, names and types folded into `list(...)` columns.
 * Nothing scrolls the table into JS — a large project holds ~10^5–10^6 rows.
 *
 * The CTE chain, in order:
 *   - `resolved` — {@link resolvedIdentifiersCte}: the persisted type, or the
 *     `call-return` type of a row bound to a single-target exact call. Narrowed
 *     BEFORE the join by the language's file extensions;
 *   - `canon_resolved` — {@link canonicalTypeNamesCte}: `resolved` with each
 *     type name folded to the symbol it denotes (`Bar` into `Foo::Bar`, `Type`
 *     into `ts.Type`) within one language, the spelling kept beside it;
 *   - `concept_all` — rows under the path scope, in production files only (the
 *     architecture report's non-production classification: tooling and test
 *     shapes out, bd tea-rags-mcp-4p3sb.25; the masks travel in the query,
 *     since the daemon process owns no language conventions), whose effective type names a
 *     concept: not a
 *     non-concept type of the row's language, not a single capital letter;
 *     value kinds only (`param`, `local`, `field` — a `return` row's name is a
 *     method name, not a value name); a name of more than one character; not
 *     an unused marker — a `param` / `local` named `_` + letter (`_ctx`), the
 *     TS / Ruby / Rust / Python convention for a binding the body ignores.
 *     Fields keep a leading `_` (Python `_private` is a real name), and a
 *     dunder (`__init__`) is no marker;
 *   - summary read: `generic` — the candidates, names bound to many types none
 *     of which dominates. Data derived, so `result` / `data` / `item` surface
 *     without a hardcoded list. Over the same scoped rows as every section: a
 *     name generic elsewhere but bound to one type here is no candidate here.
 *     Generic by type count alone — each goes out with its types, and the ops
 *     layer drops the types the name spells before it calls the name generic;
 *   - sections read: `evidence` — `concept_all` minus the rows of the caller's
 *     excluded generic names.
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
  IdentifierTypeMultiplicity,
  IdentifierTypeSource,
  OntologyCollisionRow,
  OntologyCollisionRule,
  OntologyEvidenceCounts,
  OntologyGenericNameRow,
  OntologyHomonymRow,
  OntologyLocationRow,
  OntologyNameCountRow,
  OntologyReportQuery,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  OntologyTypeGroupRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import {
  DECLARED_IDENTIFIER_SQL,
  pathPrefixPredicate,
  resolvedIdentifiersCte,
  type SqlPredicate,
} from "./identifier-store.js";
import { compileNonProductionPathPredicate } from "./non-production-path-sql.js";

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
/**
 * Deterministic example-row order: a row spelling its type as reported first
 * (a folded unqualified spelling never stands for the qualified type), then
 * first file, first line, first owner.
 */
const EXAMPLE_KEY_SQL = `CASE WHEN type_spelling IS NOT DISTINCT FROM type_name THEN '0' ELSE '1' END || ':' || rel_path || ':' || lpad(CAST(line AS VARCHAR), 10, '0') || ':' || owner_symbol_id`;
/** A type name that is one identifier (`Bar`). */
const UNQUALIFIED_TYPE_RE = `'[A-Za-z_$][A-Za-z0-9_$]*'`;
/** A type name that is a namespace path of identifiers (`Foo::Bar`, `ts.Type`). */
const QUALIFIED_TYPE_RE = `'[A-Za-z_$][A-Za-z0-9_$]*((::|\\.)[A-Za-z_$][A-Za-z0-9_$]*)+'`;
/** The last identifier of a namespace path (`Bar` of `Foo::Bar`). */
const LAST_TYPE_SEGMENT_RE = `'([A-Za-z_$][A-Za-z0-9_$]*)$'`;
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

/**
 * The files `shadowsMethod` reads: those of the languages where a local can
 * shadow a method (implicit self). `FALSE` when none — the rule is then off.
 */
function shadowsMethodFilePredicate(extensions: readonly string[]): SqlPredicate {
  if (extensions.length === 0) return { sql: "FALSE", params: [] };
  return { sql: `${EXTENSION_SQL} IN (${placeholders(extensions)})`, params: [...extensions] };
}

/** `name NOT IN (…)` over the excluded generic names; `TRUE` when there are none. */
function notExcludedNamePredicate(excludedGenericNames: readonly string[]): SqlPredicate {
  if (excludedGenericNames.length === 0) return { sql: "TRUE", params: [] };
  return { sql: `name NOT IN (${placeholders(excludedGenericNames)})`, params: [...excludedGenericNames] };
}

/**
 * The audit's file scope: the caller's path prefixes AND production files only
 * (`OntologyReportQuery.nonProductionPaths` compiled to SQL — the architecture
 * report's classification).
 */
function ontologyScopePredicate(q: OntologyReportQuery): SqlPredicate {
  const prefix = pathPrefixPredicate(q.pathPrefixes);
  const nonProduction = compileNonProductionPathPredicate(q.nonProductionPaths);
  return { sql: `(${prefix.sql} AND NOT ${nonProduction("rel_path")})`, params: prefix.params };
}

/**
 * The language a row's file belongs to, as a key: the index of the
 * `nonConceptTypes` group (one per language) its extension falls in, else the
 * extension itself. Type spellings only fold within one language.
 */
function languageKeySql(q: OntologyReportQuery, extensionSql: string): SqlPredicate {
  const arms: string[] = [];
  const params: unknown[] = [];
  q.nonConceptTypes.forEach((group, i) => {
    if (group.extensions.length === 0) return;
    arms.push(`WHEN ${extensionSql} IN (${placeholders(group.extensions)}) THEN '${i}'`);
    params.push(...group.extensions);
  });
  return arms.length === 0
    ? { sql: extensionSql, params: [] }
    : { sql: `CASE ${arms.join(" ")} ELSE ${extensionSql} END`, params };
}

/**
 * `resolved` with each type name folded to the symbol it denotes (bd
 * tea-rags-mcp-1hj3o), as `canon_resolved`; `type_spelling` keeps the name as
 * written. An unqualified spelling (`Bar`, `Type`) folds into a qualified one
 * (`Foo::Bar`, `ts.Type`) of the same language when:
 *   - exactly one qualified spelling in `cg_identifiers` ends in that segment —
 *     two (`A::Bar`, `B::Bar`) leave `Bar` ambiguous, so it folds into neither;
 *   - the two do not name two DECLARED symbols: `cg_symbols` holding both
 *     `Bar` and `Foo::Bar` means a top-level class beside a namespaced one.
 * A qualified spelling nothing declares is an access path (a module alias
 * `ns.Bar`, a library type `ts.Type`), and an unqualified one nothing declares
 * is a relative reference — each denotes the one symbol the other spells.
 */
function canonicalTypeNamesCte(q: OntologyReportQuery): SqlPredicate {
  const spellingLang = languageKeySql(q, EXTENSION_SQL);
  const rowLang = languageKeySql(q, `lower(regexp_extract(r.rel_path, '\\.[^./]+$'))`);
  return {
    sql: `typed_spellings AS (
        SELECT DISTINCT ${spellingLang.sql} AS lang, type_name FROM resolved WHERE type_name IS NOT NULL
      ),
      qualified_segments AS (
        SELECT lang, regexp_extract(type_name, ${LAST_TYPE_SEGMENT_RE}, 1) AS segment,
               min(type_name) AS qualified, count(*) AS spellings
          FROM typed_spellings
         WHERE regexp_full_match(type_name, ${QUALIFIED_TYPE_RE})
         GROUP BY lang, segment
      ),
      type_canon AS (
        SELECT t.lang, t.type_name AS spelling, q.qualified AS canonical
          FROM typed_spellings t
          JOIN qualified_segments q ON q.lang = t.lang AND q.segment = t.type_name AND q.spellings = 1
         WHERE regexp_full_match(t.type_name, ${UNQUALIFIED_TYPE_RE})
           AND NOT (EXISTS (SELECT 1 FROM cg_symbols s WHERE s.symbol_id = t.type_name)
                    AND EXISTS (SELECT 1 FROM cg_symbols s WHERE s.symbol_id = q.qualified))
      ),
      canon_resolved AS (
        SELECT r.rel_path, r.owner_symbol_id, r.kind, r.name,
               coalesce(c.canonical, r.type_name) AS type_name, r.type_name AS type_spelling,
               r.type_source, r.type_multiplicity, r.line
          FROM resolved r
          LEFT JOIN type_canon c ON c.lang = ${rowLang.sql} AND c.spelling = r.type_name
      )`,
    params: [...spellingLang.params, ...rowLang.params],
  };
}

/** The shared CTE chain up to `concept_all` — see the module doc. `resolved` stays addressable. */
function ontologyConceptCte(q: OntologyReportQuery): SqlPredicate {
  const resolved = resolvedIdentifiersCte(extensionPredicate(q.extensions));
  const canonical = canonicalTypeNamesCte(q);
  const nonConcept = nonConceptPredicate(q);
  const scope = ontologyScopePredicate(q);
  const names = namePredicate(q.names);
  return {
    sql: `${resolved.sql},
      ${canonical.sql},
      concept_all AS (
        SELECT rel_path, owner_symbol_id, kind, name, type_name, type_spelling, type_source, type_multiplicity, line
          FROM canon_resolved
         WHERE type_name IS NOT NULL
           AND kind IN ('param', 'local', 'field')
           AND NOT regexp_full_match(type_name, '[A-Z]?')
           AND length(${BARE_NAME_SQL}) > 1
           AND NOT (kind IN ('param', 'local') AND ${UNUSED_MARKER_SQL})
           AND NOT (${nonConcept.sql})
           AND ${scope.sql}
           AND ${names.sql}
      )`,
    params: [...resolved.params, ...canonical.params, ...nonConcept.params, ...scope.params, ...names.params],
  };
}

/** `name IN (…)` over `OntologyReportQuery.names`; `TRUE` when absent. */
function namePredicate(names: readonly string[] | undefined): SqlPredicate {
  if (names === undefined) return { sql: "TRUE", params: [] };
  if (names.length === 0) return { sql: "FALSE", params: [] };
  return { sql: `name IN (${placeholders(names)})`, params: [...names] };
}

/** {@link ontologyConceptCte}, then `evidence`: the concept rows minus the excluded generic names. */
function ontologyEvidenceCte(q: OntologyReportQuery, excludedGenericNames: readonly string[]): SqlPredicate {
  const concept = ontologyConceptCte(q);
  const kept = notExcludedNamePredicate(excludedGenericNames);
  return {
    sql: `${concept.sql},
      evidence AS (
        SELECT * FROM concept_all WHERE ${kept.sql}
      )`,
    params: [...concept.params, ...kept.params],
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

  /** Phase 1: the totals and every generic-name candidate of the scope, with its types. */
  async readOntologyReportSummary(q: OntologyReportQuery): Promise<OntologyReportSummaryRows> {
    const totals = await this.readTotals();
    const genericNames = await this.readGenericCandidates(q);
    return { totals, genericNameCount: genericNames.length, genericNames };
  }

  /** Phase 2: the requested sections over the scope's evidence, the `excludedGenericNames` rows dropped. */
  async readOntologyReportSections(
    q: OntologyReportQuery,
    excludedGenericNames: readonly string[],
  ): Promise<OntologyReportSectionRows> {
    const sections = new Set(q.sections);
    const base = ontologyEvidenceCte(q, excludedGenericNames);
    const t = q.thresholds;
    const confidence = `least(1.0, power(total / ${num(t.confidenceSupport)}, 2))`;
    return {
      evidenceRows: await this.readEvidenceRowCount(base),
      ...(sections.has("synonyms")
        ? {
            synonyms: await this.readTypeGroups(q, base, {
              where: `top_n < ${num(t.synonymDominantShareCeiling)} * total`,
              score: `(1 - top_n / total) * ${confidence}`,
            }),
          }
        : {}),
      ...(sections.has("homonyms") ? { homonyms: await this.readHomonyms(q, base) } : {}),
      ...(sections.has("outliers")
        ? {
            outlierGroups: await this.readTypeGroups(q, base, {
              where: `top_n >= ${num(t.outlierMinDominantShare)} * total`,
              score: `(top_n / total) * ${confidence}`,
            }),
          }
        : {}),
      ...(sections.has("collisions")
        ? {
            collisions: await this.readCollisions(
              ontologyScopePredicate(q),
              q.limit,
              base,
              notExcludedNamePredicate(excludedGenericNames),
              shadowsMethodFilePredicate(q.shadowsMethodExtensions),
            ),
          }
        : {}),
    };
  }

  private async readTotals(): Promise<OntologyReportSummaryRows["totals"]> {
    const [row] = await this.session.queryAll<Row>(
      // Declarations only: a wrapper-only `return` row serves the call-return join (bd tea-rags-mcp-bjzaf).
      `SELECT (SELECT count(*) FROM cg_identifiers WHERE ${DECLARED_IDENTIFIER_SQL}) AS identifier_rows,
              (SELECT count(*) FROM cg_symbols) AS symbol_rows`,
    );
    return { identifierRows: count(row?.identifier_rows), symbolRows: count(row?.symbol_rows) };
  }

  private async readEvidenceRowCount(base: SqlPredicate): Promise<number> {
    const [row] = await this.session.queryAll<Row>(
      `${base.sql}
       SELECT count(*) AS evidence_rows FROM evidence`,
      base.params,
    );
    return count(row?.evidence_rows);
  }

  private async readGenericCandidates(q: OntologyReportQuery): Promise<OntologyGenericNameRow[]> {
    const concept = ontologyConceptCte(q);
    const t = q.thresholds;
    const [row] = await this.session.queryAll<Row>(
      `${concept.sql},
       name_types AS (
         SELECT name, type_name, count(*) AS n FROM concept_all GROUP BY name, type_name
       ),
       generic AS (
         SELECT name, count(*) AS type_count, sum(n) AS n
           FROM name_types
          GROUP BY name
         HAVING count(*) >= ${int(t.genericMinTypes)} AND max(n) < ${num(t.genericMaxTopTypeShare)} * sum(n)
       ),
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
       SELECT (SELECT list({'name': name, 'typeCount': CAST(type_count AS INTEGER), 'n': CAST(n AS INTEGER),
                            'types': types} ORDER BY n DESC, name)
                 FROM generic_pool) AS generic_names`,
      concept.params,
    );
    return ((row?.generic_names as Row[] | null) ?? []).map((g) => ({
      name: g.name as string,
      typeCount: count(g.typeCount),
      n: count(g.n),
      types: ((g.types as Row[] | null) ?? []).map((type) => ({
        typeName: type.typeName as string,
        n: count(type.n),
        relPath: type.relPath as string,
      })),
    }));
  }

  /**
   * (type, kind, multiplicity) groups of two or more names, ranked by
   * `selection.score`, capped at `groupPool`. Multiplicity is part of the key
   * (bd tea-rags-mcp-4p3sb.26): `candidates: Def[]` and `fallback: Def` hold
   * different roles, so their names are no synonyms of each other.
   */
  private async readTypeGroups(
    q: OntologyReportQuery,
    base: SqlPredicate,
    selection: TypeGroupSelection,
  ): Promise<OntologyTypeGroupRow[]> {
    const t = q.thresholds;
    const rows = await this.session.queryAll<Row>(
      `${base.sql},
       group_names AS (
         SELECT type_name, kind, type_multiplicity, name, count(*) AS n,
                ${EXAMPLE_COLUMNS_SQL}
           FROM evidence
          GROUP BY type_name, kind, type_multiplicity, name
       ),
       groups AS (
         SELECT type_name, kind, type_multiplicity, sum(n) AS total, count(*) AS distinct_names, max(n) AS top_n,
                sum(n * ln(n)) AS n_log_n,
                list({'name': name, 'n': CAST(n AS INTEGER), 'relPath': ex_path, 'line': ex_line,
                      'ownerSymbolId': ex_owner} ORDER BY n DESC, name) AS names
           FROM group_names
          GROUP BY type_name, kind, type_multiplicity
       ),
       picked AS (
         SELECT type_name, kind, type_multiplicity, total, distinct_names, names,
                top_n / total AS dominant_share,
                (ln(total) - n_log_n / total) / ln(distinct_names) AS entropy,
                ${selection.score} AS score
           FROM groups
          WHERE total >= ${int(t.minSupport)} AND distinct_names >= 2 AND ${selection.where}
          ORDER BY score DESC, total DESC, type_name, kind, type_multiplicity
          LIMIT ${int(t.groupPool)}
       ),
       sources AS (
         SELECT type_name, kind, type_multiplicity, ${EVIDENCE_COLUMNS_SQL}
           FROM evidence JOIN picked USING (type_name, kind, type_multiplicity)
          GROUP BY type_name, kind, type_multiplicity
       )
       SELECT p.type_name, p.kind, p.type_multiplicity, CAST(p.total AS INTEGER) AS n,
              CAST(p.distinct_names AS INTEGER) AS distinct_names,
              p.dominant_share, p.entropy, list_slice(p.names, 1, ${int(t.namesPerItem)}) AS names,
              s.* EXCLUDE (type_name, kind, type_multiplicity)
         FROM picked p JOIN sources s USING (type_name, kind, type_multiplicity)
        ORDER BY p.score DESC, p.total DESC, p.type_name, p.kind, p.type_multiplicity`,
      base.params,
    );
    return rows.map((r) => ({
      typeName: r.type_name as string,
      kind: r.kind as Exclude<IdentifierDeclarationKind, "return">,
      typeMultiplicity: r.type_multiplicity as IdentifierTypeMultiplicity,
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
  private async readHomonyms(q: OntologyReportQuery, base: SqlPredicate): Promise<OntologyHomonymRow[]> {
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
   *     takes part in an inheritance edge — since `cg_symbols` records no kind.
   *     A capitalised symbol that owns a `return` row in `cg_identifiers` is a
   *     FUNCTION (Go's `NewClient`, a React component), never a type (bd
   *     tea-rags-mcp-1hj3o) — a wrapper-only `return` row (`-> Result<(), E>`,
   *     an async `Promise<void>`, bd tea-rags-mcp-bjzaf) counts: the function
   *     declares a return even when it names no value. Limitation until `cg_symbols` carries a symbol
   *     kind: a PascalCase function with no declared or inferred return type
   *     owns no `return` row and still reads as a type by its casing;
   *   - `shadowsMethod` — a local named like an instance method of its owner's
   *     class (`Report#render` declaring `title` beside `Report#title`); typed
   *     or not, since the collision is with the name, not the value. Only in
   *     `shadowsMethodFiles` — the implicit-self languages, where a bare name
   *     reaches the method and a local of that name hides it; with an explicit
   *     receiver (`this.title()`, `self.title()`) nothing is shadowed.
   */
  private async readCollisions(
    scope: SqlPredicate,
    limit: number,
    base: SqlPredicate,
    notExcluded: SqlPredicate,
    shadowsMethodFiles: SqlPredicate,
  ): Promise<OntologyCollisionRow[]> {
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
            -- ANY return row marks a callable, a wrapper-only one included (type_name NULL,
            -- '-> Result<(), E>', an async 'Promise<void>'): it too is a declared return
            -- (bd tea-rags-mcp-bjzaf), so DECLARED_IDENTIFIER_SQL is deliberately not applied.
            AND NOT EXISTS (
              SELECT 1 FROM cg_identifiers i
               WHERE i.kind = 'return' AND i.rel_path = s.rel_path AND i.owner_symbol_id = s.symbol_id
            )
            AND NOT (${ALL_CAPS_SQL("s.short_name")}
                     AND s.symbol_id NOT IN (SELECT owner_id FROM symbol_owners)
                     AND s.fq_name NOT IN (SELECT source_fq_name FROM cg_symbols_inheritance)
                     AND s.fq_name NOT IN (SELECT ancestor_fq_name FROM cg_symbols_inheritance))
          GROUP BY lower(s.short_name)
       ),
       names_other_type AS (
         SELECT 'namesOtherType' AS rule, e.name, ts.short_name AS symbol, e.type_name, e.type_spelling,
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
            AND ${notExcluded.sql}
            AND ${shadowsMethodFiles.sql}
       ),
       shadows_method AS (
         SELECT 'shadowsMethod' AS rule, l.name, l.owner_class || '#' || l.name AS symbol, NULL AS type_name,
                NULL AS type_spelling, l.rel_path, l.line, l.owner_symbol_id, l.type_source
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
        WHERE rn <= ${int(limit)}
        ORDER BY CASE rule WHEN 'namesOtherType' THEN 0 ELSE 1 END, rn`,
      [...base.params, ...scope.params, ...notExcluded.params, ...shadowsMethodFiles.params],
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
