/**
 * The current state of a Rails table, folded from the migration corpus
 * (bd tea-rags-mcp-nplgm). Shared by the Ruby fold that computes it
 * (`domains/language/ruby/schema/`), the explore query that feeds it the
 * corpus points, and the `find_symbol(symbol: "table:<name>")` answer.
 *
 * Every fact carries the migration chunk id (`migration:<path>:<op>:<n>`) of
 * the operation it came from, so the answer is drillable with find_symbol.
 */

/** One migration-corpus operation as the fold reads it — the corpus point payload, parts reassembled. */
export interface RailsMigrationOperation {
  /** Migration chunk id, `migration:<relativePath>:<operation>:<ordinal>`, without a `#partN` suffix. */
  symbolId: string;
  /** Migration timestamp from the file name; absent when the file name carries none. */
  version?: string;
  operation: string;
  /** Enclosing migration method: `change`, `up` or `down`. */
  direction?: string;
  table?: string;
  columns: readonly string[];
  /** The operation's source text. */
  content: string;
}

export interface RailsTableColumn {
  name: string;
  /** Column type when the operation text states it (`t.string`, `add_column … :uuid`, `t.references` → bigint). */
  type?: string;
  /** Migration chunk id that created the column. */
  origin: string;
  /** The column's name before the first rename. */
  renamedFrom?: string;
}

export interface RailsTableIndex {
  /** Index name when the operation gives one; Rails generates it otherwise. */
  name?: string;
  columns: string[];
  unique: boolean;
  origin: string;
  /** The index's name before the first `rename_index`. */
  renamedFrom?: string;
  /** A partial index's `where:` predicate, as written; absent for a full index. */
  where?: string;
}

export interface RailsTableForeignKey {
  toTable: string;
  column: string;
  origin: string;
  /** `on_delete:` action (`cascade`, `nullify`, `restrict`…); absent when not declared. */
  onDelete?: string;
  /** `on_update:` action; absent when not declared. */
  onUpdate?: string;
}

/** An operation that could not be applied deterministically, so the state may miss its effect. */
export interface RailsTableUnfoldedOperation {
  symbolId: string;
  operation: string;
  reason: string;
}

export interface RailsTableState {
  table: string;
  columns: RailsTableColumn[];
  indexes: RailsTableIndex[];
  foreignKeys: RailsTableForeignKey[];
  /** Present when the last applicable operation dropped (or renamed away) the table. */
  dropped?: { origin: string; renamedTo?: string };
  unfolded: RailsTableUnfoldedOperation[];
  /** Every `change`/`up` operation read for the table, in fold order. */
  provenance: string[];
}

/** The fold, injected into the explore read path by the API layer. */
export type RailsTableMigrationFold = (
  table: string,
  operations: readonly RailsMigrationOperation[],
) => RailsTableState;
