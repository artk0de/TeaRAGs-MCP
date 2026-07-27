/**
 * Reader for the Rails schema snapshot (`db/schema.rb`) — the ONLY place a
 * column name is derived from persisted schema in this project
 * (bd tea-rags-mcp-8l5fo).
 *
 * Why this file exists at all. A Rails column accessor (`firm.name`,
 * `firm.firm_id`, `firm.created_at`) has NO `def` anywhere: ActiveRecord
 * generates it at boot from the database schema. Statically that makes every
 * such call an unresolvable miss, and the column short-names are the top
 * ambiguous aggregates on a real Rails corpus. `db/schema.rb` is the checked-in,
 * machine-generated snapshot of exactly those columns, so it is the missing
 * declaration site.
 *
 * Why a LINE reader rather than a tree-sitter walk. `db/schema.rb` is excluded
 * from the codegraph walk by design (`RUBY_CODEGRAPH_EXCLUSION_GLOBS` — it is a
 * generated procedural DSL over an untyped block receiver `t`, and walking it
 * fabricates a bucket of dynamic-receiver misses), so no AST for it exists at
 * the barrier. It is also not hand-written source: `ActiveRecord::SchemaDumper`
 * emits one statement per line in a fixed shape, which is why the equivalent
 * reader in `scripts/taxdome-codegraph-recall-forensics.ts` (the duck-typing
 * oracle, 2026-07-26) mapped 342 of taxdome's 367 tables with zero ambiguity.
 * This is an adaptation of that proven reader — the codegraph-walker
 * "no regex over source code" rule targets walkers over human-authored code,
 * and a second tree-sitter parse of a generated data file would buy nothing.
 *
 * Grammar covered, one statement per line:
 *   create_table "x", force: :cascade do |t|   opens a table
 *   create_table "x", id: false, …             opens it with NO implicit `id`
 *   create_table "x", primary_key: "uuid", …   opens it with `uuid` as the key
 *   t.<type> "col", …                          declares a column
 *   t.timestamps                               declares created_at + updated_at
 *   t.index / t.check_constraint / …           declare NO column
 *   end                                        closes the table
 */
import type { SchemaColumnAccessorSource, SchemaTableColumns } from "../../../../contracts/types/language.js";
import {
  ACTIVE_RECORD_QUERY_INTERFACE,
  ACTIVE_RECORD_SCHEMA_SNAPSHOT,
  columnAccessors,
  singularizeAssociation,
} from "../dsl/index.js";

/** `create_table "firms", force: :cascade do |t|` — captures name + option text. */
const CREATE_TABLE_RE = /^\s*create_table\s+"([^"]+)"([^\n]*)\bdo\s*\|/;
/** `t.string "name", limit: 40` — captures the type verb + column name. */
const COLUMN_RE = /^\s*t\.(\w+)\s+"([^"]+)"/;
/** `primary_key: "uuid"` inside the create_table options. */
const PRIMARY_KEY_RE = /primary_key:\s*"([^"]+)"/;
/** `id: false` inside the create_table options. */
const NO_ID_RE = /\bid:\s*false\b/;
const TIMESTAMPS_RE = /^\s*t\.timestamps\b/;
const END_RE = /^\s*end\s*$/;

/**
 * Parse a `db/schema.rb` snapshot into one entry per table, each carrying the
 * instance-accessor names its columns synthesize. Column→accessor expansion is
 * the DSL's `columnAccessors` rule (reader / writer / query) — this reader owns
 * only WHICH columns exist, never what methods a column implies.
 *
 * Deliberately total: an unparseable or truncated snapshot yields whatever
 * tables it could read (possibly none), never an exception. A missing table is
 * silence; a fabricated one would be a wrong edge.
 */
export function parseRailsSchemaSnapshot(source: string): SchemaTableColumns[] {
  const tables: SchemaTableColumns[] = [];
  let columns: string[] | null = null;

  const close = (table: string | null): void => {
    if (table !== null && columns !== null) {
      tables.push({ table, accessors: columns.flatMap((c) => columnAccessors(c).map((m) => m.name)) });
    }
    columns = null;
  };

  let openTable: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const created = CREATE_TABLE_RE.exec(line);
    if (created !== null) {
      // A nested/unterminated block would leave the previous table open; flush it
      // rather than silently merging two tables' columns.
      close(openTable);
      const options = created[2] ?? "";
      const primaryKey = PRIMARY_KEY_RE.exec(options)?.[1] ?? null;
      openTable = created[1] ?? null;
      columns = [];
      if (primaryKey !== null) columns.push(primaryKey);
      else if (!NO_ID_RE.test(options)) columns.push(ACTIVE_RECORD_SCHEMA_SNAPSHOT.implicitPrimaryKey);
      continue;
    }
    if (columns === null) continue;
    if (END_RE.test(line)) {
      close(openTable);
      openTable = null;
      continue;
    }
    if (TIMESTAMPS_RE.test(line)) {
      columns.push(...ACTIVE_RECORD_SCHEMA_SNAPSHOT.timestampColumns);
      continue;
    }
    const column = COLUMN_RE.exec(line);
    if (column !== null && !ACTIVE_RECORD_SCHEMA_SNAPSHOT.nonColumnVerbs.has(column[1] ?? "")) {
      columns.push(column[2] ?? "");
    }
  }
  close(openTable);
  return tables;
}

/**
 * Rails convention model name for a table: singularize, then camelize
 * (`firms` → `Firm`, `firm_settings` → `FirmSetting`). Reuses the association
 * inflector so the project has ONE singularization rule; it is a fallback only —
 * an explicit `self.table_name` in the model always wins upstream.
 */
export function railsModelNameForTable(table: string): string {
  return singularizeAssociation(table)
    .split("_")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/** Ruby's persisted-schema column vocabulary, as the codegraph engine consumes it. */
export const RAILS_SCHEMA_COLUMN_ACCESSORS: SchemaColumnAccessorSource = {
  schemaRelPath: ACTIVE_RECORD_SCHEMA_SNAPSHOT.relPath,
  parseSchema: parseRailsSchemaSnapshot,
  modelNameForTable: railsModelNameForTable,
  // Same AR-model gate the resolver's query-interface fallback uses; declared
  // once in `dsl/rails.ts` and re-exported here, never a second literal.
  modelBaseClasses: [...ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses],
};
