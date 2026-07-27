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
 *   create_table "x", id: :uuid, …             opens it with a non-default key type
 *   t.<type> "col", …                          declares a column of that type
 *   t.<type> "col", array: true                declares an ARRAY column of it
 *   t.timestamps                               declares created_at + updated_at
 *   t.index / t.check_constraint / …           declare NO column
 *   end                                        closes the table
 *
 * The declared TYPE token is kept, not just the name (bd tea-rags-mcp-2a5oo):
 * `t.string "name"` types the reader as `String`, which is what lets a chain
 * continue past the column hop instead of dying there. Which Ruby class a token
 * names — and which tokens have no honest answer — is the DSL's data
 * (`columnValueAccessor`); this reader only carries the token across.
 */
import type {
  RubyTypeRef,
  SchemaColumnAccessorSource,
  SchemaTableColumns,
} from "../../../../contracts/types/language.js";
import {
  ACTIVE_RECORD_QUERY_INTERFACE,
  ACTIVE_RECORD_SCHEMA_SNAPSHOT,
  columnAccessors,
  columnValueAccessor,
  singularizeAssociation,
} from "../dsl/index.js";

/** `create_table "firms", force: :cascade do |t|` — captures name + option text. */
const CREATE_TABLE_RE = /^\s*create_table\s+"([^"]+)"([^\n]*)\bdo\s*\|/;
/** `t.string "name", limit: 40` — captures the type verb + column name. */
const COLUMN_RE = /^\s*t\.(\w+)\s+"([^"]+)"/;
/** `array: true` on a column statement — a PG array of the declared type. */
const ARRAY_COLUMN_RE = /\barray:\s*true\b/;
/** `primary_key: "uuid"` inside the create_table options. */
const PRIMARY_KEY_RE = /primary_key:\s*"([^"]+)"/;
/** `id: false` inside the create_table options. */
const NO_ID_RE = /\bid:\s*false\b/;
/** `id: :uuid` inside the create_table options — the key's declared type. */
const ID_TYPE_RE = /\bid:\s*:(\w+)/;
const TIMESTAMPS_RE = /^\s*t\.timestamps\b/;
const END_RE = /^\s*end\s*$/;

/** One table being read: its name, its column names, and the typed readers so far. */
interface OpenSchemaTable {
  readonly table: string;
  readonly columns: string[];
  readonly accessorReturnTypes: Record<string, RubyTypeRef>;
}

/**
 * Record one column: its accessor names always, its reader's value type only
 * when the declared token maps to a Ruby class (silence otherwise).
 */
function addColumn(open: OpenSchemaTable, name: string, columnType: string | null, isArray = false): void {
  open.columns.push(name);
  const typed = columnType === null ? undefined : columnValueAccessor(name, columnType, isArray);
  if (typed !== undefined) open.accessorReturnTypes[typed.accessor] = typed.type;
}

/**
 * The primary-key column a `create_table` options string declares, or `null`
 * when it declares none (`id: false`).
 *
 * A RENAMED key (`primary_key: "version"`) is typed ONLY from an explicit
 * `id:` token: the bigint default belongs to the implicit `id`, and assuming it
 * for a renamed key would fabricate `Integer` for a key that is often a string.
 */
function primaryKeyColumn(options: string): { name: string; type: string | null } | null {
  const declaredType = ID_TYPE_RE.exec(options)?.[1] ?? null;
  const renamed = PRIMARY_KEY_RE.exec(options)?.[1] ?? null;
  if (renamed !== null) return { name: renamed, type: declaredType };
  if (NO_ID_RE.test(options)) return null;
  return {
    name: ACTIVE_RECORD_SCHEMA_SNAPSHOT.implicitPrimaryKey,
    type: declaredType ?? ACTIVE_RECORD_SCHEMA_SNAPSHOT.implicitPrimaryKeyType,
  };
}

/**
 * Parse a `db/schema.rb` snapshot into one entry per table, each carrying the
 * instance-accessor names its columns synthesize plus the value types of the
 * readers among them. Column→accessor expansion is the DSL's `columnAccessors`
 * rule (reader / writer / query) and column→type the DSL's
 * `columnValueAccessor` — this reader owns only WHICH columns exist and what
 * each was declared as, never what methods or types a column implies.
 *
 * Deliberately total: an unparseable or truncated snapshot yields whatever
 * tables it could read (possibly none), never an exception. A missing table is
 * silence; a fabricated one would be a wrong edge.
 */
export function parseRailsSchemaSnapshot(source: string): SchemaTableColumns[] {
  const tables: SchemaTableColumns[] = [];
  let open: OpenSchemaTable | null = null;

  const close = (): void => {
    if (open === null) return;
    tables.push({
      table: open.table,
      accessors: open.columns.flatMap((c) => columnAccessors(c).map((m) => m.name)),
      accessorReturnTypes: open.accessorReturnTypes,
    });
    open = null;
  };

  for (const line of source.split(/\r?\n/)) {
    const created = CREATE_TABLE_RE.exec(line);
    if (created !== null) {
      // A nested/unterminated block would leave the previous table open; flush it
      // rather than silently merging two tables' columns.
      close();
      open = { table: created[1] ?? "", columns: [], accessorReturnTypes: {} };
      const primaryKey = primaryKeyColumn(created[2] ?? "");
      if (primaryKey !== null) addColumn(open, primaryKey.name, primaryKey.type);
      continue;
    }
    if (open === null) continue;
    if (END_RE.test(line)) {
      close();
      continue;
    }
    if (TIMESTAMPS_RE.test(line)) {
      for (const column of ACTIVE_RECORD_SCHEMA_SNAPSHOT.timestampColumns) {
        addColumn(open, column, ACTIVE_RECORD_SCHEMA_SNAPSHOT.timestampColumnType);
      }
      continue;
    }
    const column = COLUMN_RE.exec(line);
    if (column !== null && !ACTIVE_RECORD_SCHEMA_SNAPSHOT.nonColumnVerbs.has(column[1] ?? "")) {
      addColumn(open, column[2] ?? "", column[1] ?? null, ARRAY_COLUMN_RE.test(line));
    }
  }
  close();
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
