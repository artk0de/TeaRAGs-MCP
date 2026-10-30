/**
 * Fold of one Rails table's migration operations into its current state
 * (bd tea-rags-mcp-nplgm) — the Ruby-language half of
 * `find_symbol(symbol: "table:<name>")`. Pure: corpus points in, state out.
 *
 * Rule: only `change` / `up` operations shape the current state, applied in
 * version order (then file, then source order); `down` operations describe a
 * rollback and are ignored. An operation whose effect cannot be computed from
 * its own text (raw SQL, an unknown builder call, an index the fold never saw)
 * is reported in `unfolded` rather than guessed.
 *
 * Why the operation TEXT is read here. The corpus payload records the table and
 * the column names, not the options that matter for state — the column type,
 * `unique:`, `index:`, `foreign_key: {to_table:}`, `polymorphic:`. The chunk
 * content is the operation's own source, and a migration argument list is a
 * flat sequence of literals and `key: value` pairs, so a literal-level scanner
 * reads it exactly; re-parsing every chunk with tree-sitter on the read path
 * would buy nothing over it. (The codegraph "no regex over source" rule is for
 * walkers resolving human-authored code, as `rails-schema-snapshot.ts` notes.)
 */

import type {
  RailsMigrationOperation,
  RailsTableColumn,
  RailsTableForeignKey,
  RailsTableIndex,
  RailsTableState,
  RailsTableUnfoldedOperation,
} from "../../../../contracts/types/rails-table-state.js";

// ---------------------------------------------------------------------------
// Ruby literal scanner
// ---------------------------------------------------------------------------

type RubyLiteral =
  | { kind: "name"; text: string }
  | { kind: "array"; items: RubyLiteral[] }
  | { kind: "hash"; entries: Map<string, RubyLiteral> }
  | { kind: "boolean"; value: boolean }
  | { kind: "raw"; text: string };

interface RubyArguments {
  positional: RubyLiteral[];
  options: Map<string, RubyLiteral>;
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Walk `source` outside string literals, reporting each character with the
 * bracket depth before it. Comments (`#` to end of line) are skipped.
 */
function walkCode(source: string, visit: (char: string, index: number, depth: number) => void): void {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      while (index + 1 < source.length && source[index + 1] !== "\n") index++;
      continue;
    }
    if (CLOSERS.has(char)) depth--;
    visit(char, index, depth);
    if (OPENERS.has(char)) depth++;
  }
}

/** Source with comments blanked, so later scans never read inside one. */
function withoutComments(source: string): string {
  const kept: string[] = [];
  let last = 0;
  let quote: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#") {
      kept.push(source.slice(last, index));
      while (index + 1 < source.length && source[index + 1] !== "\n") index++;
      last = index + 1;
    }
  }
  kept.push(source.slice(last));
  return kept.join("");
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  walkCode(source, (char, index, depth) => {
    if (depth === 0 && char === separator) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  });
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseLiteral(text: string): RubyLiteral {
  const source = text.trim();
  if (/^:\w+[!?]?$/.test(source)) return { kind: "name", text: source.slice(1) };
  if (/^'[^']*'$/.test(source) || (/^"[^"]*"$/.test(source) && !source.includes("#{"))) {
    return { kind: "name", text: source.slice(1, -1) };
  }
  if (source === "true" || source === "false") return { kind: "boolean", value: source === "true" };
  const wordArray = /^%[iIwW]\[([^\]]*)\]$/.exec(source);
  if (wordArray) {
    return {
      kind: "array",
      items: wordArray[1]
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ kind: "name", text: word })),
    };
  }
  if (source.startsWith("[") && source.endsWith("]")) {
    return { kind: "array", items: splitTopLevel(source.slice(1, -1), ",").map(parseLiteral) };
  }
  if (source.startsWith("{") && source.endsWith("}")) {
    return { kind: "hash", entries: parseArguments(source.slice(1, -1)).options };
  }
  return { kind: "raw", text: source };
}

function parseArguments(source: string): RubyArguments {
  const positional: RubyLiteral[] = [];
  const options = new Map<string, RubyLiteral>();
  for (const part of splitTopLevel(source, ",")) {
    const pair = /^(\w+):\s+([\s\S]*)$/.exec(part) ?? /^:(\w+)\s*=>\s*([\s\S]*)$/.exec(part);
    if (pair) options.set(pair[1], parseLiteral(pair[2]));
    else positional.push(parseLiteral(part));
  }
  return { positional, options };
}

interface RubyCall {
  method: string;
  args: RubyArguments;
  /** The block's statements, comments removed and continuation lines joined. */
  blockStatements?: string[];
  /** The block's first parameter (`|t|`). */
  blockParameter?: string;
}

function blockStart(source: string): number | undefined {
  let found: number | undefined;
  walkCode(source, (char, index, depth) => {
    if (found !== undefined || depth !== 0) return;
    const doKeyword =
      source.startsWith("do", index) && /\s/.test(source[index - 1] ?? "") && /[\s|]/.test(source[index + 2] ?? "\n");
    const braceBlock = char === "{" && /^\{\s*\|/.test(source.slice(index));
    if (doKeyword || braceBlock) found = index;
  });
  return found;
}

function statementsOf(body: string): string[] {
  const statements: string[] = [];
  for (const line of splitTopLevel(body, "\n")) {
    const previous = statements.at(-1);
    if (previous !== undefined && /[,\\]$/.test(previous)) statements[statements.length - 1] = `${previous} ${line}`;
    else statements.push(line);
  }
  return statements;
}

function parseCall(content: string): RubyCall | undefined {
  const source = withoutComments(content).trim();
  const head = /^([\w.]+[!?]?)/.exec(source);
  if (!head) return undefined;
  let rest = source.slice(head[1].length);
  let blockSource: string | undefined;
  const start = blockStart(rest);
  if (start !== undefined) {
    blockSource = rest.slice(start);
    rest = rest.slice(0, start);
  }
  rest = rest.trim();
  if (rest.startsWith("(") && rest.endsWith(")")) rest = rest.slice(1, -1);
  const call: RubyCall = { method: head[1], args: parseArguments(rest) };
  if (blockSource !== undefined) {
    const opened = blockSource.startsWith("{")
      ? blockSource.slice(1).replace(/\}\s*$/, "")
      : blockSource.slice(2).replace(/\bend\s*$/, "");
    const parameter = /^\s*\|\s*(\w+)[^|]*\|/.exec(opened);
    call.blockParameter = parameter?.[1];
    call.blockStatements = statementsOf(parameter ? opened.slice(parameter[0].length) : opened);
  }
  return call;
}

// ---------------------------------------------------------------------------
// Literal readers
// ---------------------------------------------------------------------------

function nameOf(literal: RubyLiteral | undefined): string | undefined {
  return literal?.kind === "name" ? literal.text : undefined;
}

function namesOf(literal: RubyLiteral | undefined): string[] {
  if (!literal) return [];
  if (literal.kind === "name") return [literal.text];
  if (literal.kind === "array") return literal.items.flatMap(namesOf);
  if (literal.kind === "raw") return [literal.text];
  return [];
}

function isTruthy(literal: RubyLiteral | undefined): boolean {
  if (literal === undefined) return false;
  if (literal.kind === "boolean") return literal.value;
  return !(literal.kind === "raw" && literal.text === "nil");
}

/** Rails' default inflection for the regular English plurals a table name uses. */
function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function singularize(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

const COLUMN_TYPES = new Set([
  "string",
  "text",
  "integer",
  "bigint",
  "smallint",
  "float",
  "decimal",
  "numeric",
  "datetime",
  "timestamp",
  "timestamptz",
  "time",
  "date",
  "binary",
  "boolean",
  "json",
  "jsonb",
  "uuid",
  "inet",
  "cidr",
  "macaddr",
  "citext",
  "hstore",
  "ltree",
  "tsvector",
  "interval",
  "money",
  "point",
  "xml",
  "virtual",
  "enum",
  "serial",
  "bigserial",
]);

/** Operations that change no fact this state tracks (defaults, nullability, comments, checks). */
const STATE_NEUTRAL_OPERATIONS = new Set([
  "change_column_default",
  "change_column_null",
  "change_column_comment",
  "change_table_comment",
  "add_check_constraint",
  "remove_check_constraint",
  "validate_foreign_key",
  "validate_check_constraint",
]);

class RailsTableFold {
  readonly columns: RailsTableColumn[] = [];
  indexes: RailsTableIndex[] = [];
  foreignKeys: RailsTableForeignKey[] = [];
  dropped?: { origin: string; renamedTo?: string };
  readonly unfolded: RailsTableUnfoldedOperation[] = [];
  /** The operation being applied — the origin every fact it records carries. */
  private operation!: RailsMigrationOperation;

  apply(operation: RailsMigrationOperation): void {
    this.operation = operation;
    const call = parseCall(operation.content);
    if (operation.operation === "execute") {
      this.unfold("raw SQL is not folded");
      return;
    }
    if (STATE_NEUTRAL_OPERATIONS.has(operation.operation)) return;
    if (call?.method !== operation.operation) {
      this.unfold(`${operation.operation} text could not be read`);
      return;
    }
    const [, ...rest] = call.args.positional;
    const { options } = call.args;
    switch (operation.operation) {
      case "create_table": {
        this.createTable(call);
        return;
      }
      case "change_table": {
        this.applyBuilderBlock(call);
        return;
      }
      case "drop_table": {
        this.drop();
        return;
      }
      case "rename_table": {
        this.drop(nameOf(rest[0]));
        return;
      }
      case "add_column": {
        this.addColumn(nameOf(rest[0]), nameOf(rest[1]));
        return;
      }
      case "remove_column":
      case "remove_columns": {
        this.removeColumns(operation.operation === "remove_column" ? namesOf(rest[0]) : rest.flatMap(namesOf));
        return;
      }
      case "rename_column": {
        this.renameColumn(nameOf(rest[0]), nameOf(rest[1]));
        return;
      }
      case "change_column": {
        this.changeColumn(nameOf(rest[0]), nameOf(rest[1]));
        return;
      }
      case "add_index": {
        this.addIndex(namesOf(rest[0]), options);
        return;
      }
      case "remove_index": {
        this.removeIndex(rest[0] ? namesOf(rest[0]) : namesOf(options.get("column")), nameOf(options.get("name")));
        return;
      }
      case "rename_index": {
        this.renameIndex(nameOf(rest[0]), nameOf(rest[1]));
        return;
      }
      case "add_reference":
      case "add_belongs_to": {
        this.addReference(nameOf(rest[0]), options);
        return;
      }
      case "remove_reference":
      case "remove_belongs_to": {
        this.removeReference(nameOf(rest[0]), options);
        return;
      }
      case "add_foreign_key": {
        this.addForeignKey(nameOf(rest[0]), options);
        return;
      }
      case "remove_foreign_key": {
        this.removeForeignKey(nameOf(rest[0]), nameOf(options.get("column")), nameOf(options.get("to_table")));
        return;
      }
      case "add_timestamps": {
        this.addTimestamps();
        return;
      }
      case "remove_timestamps": {
        this.removeColumns(["created_at", "updated_at"]);
        return;
      }
      case "create_join_table": {
        this.unfold("a join table's name is derived from both tables");
        return;
      }
      default: {
        this.unfold(`${operation.operation} is not a schema operation the fold knows`);
      }
    }
  }

  private unfold(reason: string): void {
    const { symbolId, operation } = this.operation;
    if (this.unfolded.some((entry) => entry.symbolId === symbolId && entry.reason === reason)) return;
    this.unfolded.push({ symbolId, operation, reason });
  }

  private createTable(call: RubyCall): void {
    this.columns.length = 0;
    this.indexes = [];
    this.foreignKeys = [];
    this.dropped = undefined;
    const { options } = call.args;
    const id = options.get("id");
    if (!(id?.kind === "boolean" && !id.value)) {
      this.addColumn(nameOf(options.get("primary_key")) ?? "id", nameOf(id) ?? "primary_key");
    }
    this.applyBuilderBlock(call);
  }

  private drop(renamedTo?: string): void {
    this.columns.length = 0;
    this.indexes = [];
    this.foreignKeys = [];
    this.dropped = { origin: this.operation.symbolId, ...(renamedTo ? { renamedTo } : {}) };
  }

  private applyBuilderBlock(call: RubyCall): void {
    const builder = call.blockParameter;
    if (!builder || !call.blockStatements) return;
    for (const statement of call.blockStatements) {
      const builderCall = statement.startsWith(`${builder}.`)
        ? parseCall(statement.slice(builder.length + 1))
        : undefined;
      if (!builderCall) {
        this.unfold(`${/^\S+/.exec(statement)?.[0] ?? statement} is not a table-builder call the fold knows`);
        continue;
      }
      this.applyBuilderCall(builder, builderCall);
    }
  }

  private applyBuilderCall(builder: string, call: RubyCall): void {
    const { positional, options } = call.args;
    const { method } = call;
    if (COLUMN_TYPES.has(method)) {
      for (const literal of positional) this.addColumn(nameOf(literal), method);
      return;
    }
    switch (method) {
      case "column": {
        this.addColumn(nameOf(positional[0]), nameOf(positional[1]));
        return;
      }
      case "references":
      case "belongs_to":
        for (const literal of positional) this.addReference(nameOf(literal), options);
        return;
      case "timestamps": {
        this.addTimestamps();
        return;
      }
      case "index": {
        this.addIndex(namesOf(positional[0]), options);
        return;
      }
      case "remove": {
        this.removeColumns(positional.flatMap(namesOf));
        return;
      }
      case "rename": {
        this.renameColumn(nameOf(positional[0]), nameOf(positional[1]));
        return;
      }
      case "change": {
        this.changeColumn(nameOf(positional[0]), nameOf(positional[1]));
        return;
      }
      case "remove_index": {
        this.removeIndex(
          positional[0] ? namesOf(positional[0]) : namesOf(options.get("column")),
          nameOf(options.get("name")),
        );
        return;
      }
      case "remove_references":
      case "remove_belongs_to":
        for (const literal of positional) this.removeReference(nameOf(literal), options);
        return;
      case "remove_timestamps": {
        this.removeColumns(["created_at", "updated_at"]);
        return;
      }
      case "change_default":
      case "change_null":
      case "check_constraint":
        return;
      default: {
        this.unfold(`${builder}.${method} is not a table-builder call the fold knows`);
      }
    }
  }

  private column(name: string): RailsTableColumn | undefined {
    return this.columns.find((entry) => entry.name === name);
  }

  private addColumn(name: string | undefined, type: string | undefined): void {
    if (!name) {
      this.unfold("column name is not a literal");
      return;
    }
    const existing = this.column(name);
    if (existing) {
      if (type) existing.type = type;
      return;
    }
    this.columns.push({ name, ...(type ? { type } : {}), origin: this.operation.symbolId });
  }

  private addTimestamps(): void {
    this.addColumn("created_at", "datetime");
    this.addColumn("updated_at", "datetime");
  }

  private removeColumns(names: readonly string[]): void {
    for (const name of names) {
      const index = this.columns.findIndex((entry) => entry.name === name);
      if (index >= 0) this.columns.splice(index, 1);
    }
    // PostgreSQL drops an index and a constraint with the column they cover.
    this.indexes = this.indexes.filter((index) => !index.columns.some((column) => names.includes(column)));
    this.foreignKeys = this.foreignKeys.filter((key) => !names.includes(key.column));
  }

  private renameColumn(from: string | undefined, to: string | undefined): void {
    if (!from || !to) {
      this.unfold("column names are not literals");
      return;
    }
    const existing = this.column(from);
    if (!existing) {
      this.unfold(`renames ${from}, a column the fold has not seen`);
      return;
    }
    existing.renamedFrom ??= from;
    existing.name = to;
    for (const index of this.indexes) index.columns = index.columns.map((column) => (column === from ? to : column));
    for (const key of this.foreignKeys) if (key.column === from) key.column = to;
  }

  private changeColumn(name: string | undefined, type: string | undefined): void {
    const existing = name ? this.column(name) : undefined;
    if (!existing) {
      this.unfold(`changes ${name ?? "a column"} the fold has not seen`);
      return;
    }
    if (type) existing.type = type;
  }

  private addIndex(columns: string[], options: Map<string, RubyLiteral>): void {
    if (columns.length === 0) {
      this.unfold("index columns are not literals");
      return;
    }
    const name = nameOf(options.get("name"));
    if (name && this.indexes.some((index) => index.name === name)) return;
    this.indexes.push({
      ...(name ? { name } : {}),
      columns,
      unique: isTruthy(options.get("unique")),
      origin: this.operation.symbolId,
    });
  }

  private removeIndex(columns: string[], name: string | undefined): void {
    const position = name
      ? this.indexes.findIndex((index) => index.name === name)
      : this.indexes.findIndex((index) => index.columns.join(",") === columns.join(","));
    if (position < 0) {
      this.unfold(`removes ${name ?? columns.join(", ")}, an index the fold has not seen`);
      return;
    }
    this.indexes.splice(position, 1);
  }

  private renameIndex(from: string | undefined, to: string | undefined): void {
    const existing = from ? this.indexes.find((index) => index.name === from) : undefined;
    if (!existing || !to) {
      this.unfold(`renames ${from ?? "an index"}, an index the fold has not seen`);
      return;
    }
    existing.renamedFrom ??= from;
    existing.name = to;
  }

  /** `t.references` / `add_reference`: `<name>_id` (+ `<name>_type`), an index by default, an optional constraint. */
  private addReference(name: string | undefined, options: Map<string, RubyLiteral>): void {
    if (!name) {
      this.unfold("reference name is not a literal");
      return;
    }
    const polymorphic = isTruthy(options.get("polymorphic"));
    const column = `${name}_id`;
    if (polymorphic) this.addColumn(`${name}_type`, "string");
    this.addColumn(column, nameOf(options.get("type")) ?? "bigint");
    const index = options.get("index");
    if (index === undefined || isTruthy(index)) {
      this.addIndex(
        polymorphic ? [`${name}_type`, column] : [column],
        index?.kind === "hash" ? index.entries : new Map<string, RubyLiteral>(),
      );
    }
    const foreignKey = options.get("foreign_key");
    if (!polymorphic && foreignKey !== undefined && isTruthy(foreignKey)) {
      const toTable = foreignKey.kind === "hash" ? nameOf(foreignKey.entries.get("to_table")) : undefined;
      this.foreignKeys.push({ toTable: toTable ?? pluralize(name), column, origin: this.operation.symbolId });
    }
  }

  private removeReference(name: string | undefined, options: Map<string, RubyLiteral>): void {
    if (!name) {
      this.unfold("reference name is not a literal");
      return;
    }
    this.removeColumns(isTruthy(options.get("polymorphic")) ? [`${name}_id`, `${name}_type`] : [`${name}_id`]);
  }

  private addForeignKey(toTable: string | undefined, options: Map<string, RubyLiteral>): void {
    if (!toTable) {
      this.unfold("referenced table is not a literal");
      return;
    }
    const column = nameOf(options.get("column")) ?? `${singularize(toTable)}_id`;
    this.foreignKeys.push({ toTable, column, origin: this.operation.symbolId });
  }

  private removeForeignKey(
    toTable: string | undefined,
    column: string | undefined,
    toTableOption: string | undefined,
  ): void {
    const target = toTable ?? toTableOption;
    const position = this.foreignKeys.findIndex(
      (key) => (column === undefined || key.column === column) && (target === undefined || key.toTable === target),
    );
    if (position < 0 || (column === undefined && target === undefined)) {
      this.unfold("removes a foreign key the fold has not seen");
      return;
    }
    this.foreignKeys.splice(position, 1);
  }
}

/** `[version, path, ordinal]` of a migration chunk id — the order its operation ran in. */
function runOrderOf(operation: RailsMigrationOperation): [string, string, number] {
  const parts = /^migration:(.*):[^:]+:(\d+)$/.exec(operation.symbolId);
  return [operation.version ?? "", parts?.[1] ?? operation.symbolId, Number(parts?.[2] ?? 0)];
}

function compareRunOrder(left: RailsMigrationOperation, right: RailsMigrationOperation): number {
  const [leftVersion, leftPath, leftOrdinal] = runOrderOf(left);
  const [rightVersion, rightPath, rightOrdinal] = runOrderOf(right);
  return leftVersion.localeCompare(rightVersion) || leftPath.localeCompare(rightPath) || leftOrdinal - rightOrdinal;
}

export function foldRailsTableMigrations(
  table: string,
  operations: readonly RailsMigrationOperation[],
): RailsTableState {
  const fold = new RailsTableFold();
  const applied = operations.filter((operation) => operation.direction !== "down").sort(compareRunOrder);
  for (const operation of applied) fold.apply(operation);
  return {
    table,
    columns: fold.columns,
    indexes: fold.indexes,
    foreignKeys: fold.foreignKeys,
    ...(fold.dropped ? { dropped: fold.dropped } : {}),
    unfolded: fold.unfolded,
    provenance: applied.map((operation) => operation.symbolId),
  };
}
