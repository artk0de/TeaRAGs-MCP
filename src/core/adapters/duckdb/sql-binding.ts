/**
 * Value-safety layer for every SQL statement the DuckDB codegraph adapter
 * issues: positional parameter binding (the only route a runtime value takes
 * into DuckDB here) and `LIKE`-literal escaping for the one read that
 * pattern-matches a symbol-name segment.
 *
 * Table and column names are always compile-time literals supplied by the
 * adapter itself; everything that originates outside the process goes through
 * `bindParams`, so injection is structurally impossible rather than filtered.
 */

// Bind a positional parameter list onto a prepared statement, mapping
// the small set of value shapes the codegraph DDL uses today
// (VARCHAR everywhere — including the integer-shape columns, which DuckDB
// coerces transparently). If a new column type lands later, extend here.
export type BindablePrimitive = string | number | boolean | null | undefined;

export function asBindable(params: unknown[]): BindablePrimitive[] {
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p === "string" || typeof p === "number" || typeof p === "boolean") return p;
    throw new Error(`DuckDbGraphClient: unsupported bind param type ${typeof p} (value: ${JSON.stringify(p)})`);
  });
}

export interface BindablePrep {
  bindVarchar: (i: number, v: string) => void;
  bindNull: (i: number) => void;
}

export function bindParams(prep: BindablePrep, params: BindablePrimitive[]): void {
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v === null || v === undefined) {
      prep.bindNull(i + 1);
    } else {
      prep.bindVarchar(i + 1, String(v));
    }
  }
}

/**
 * Escape SQL `LIKE` metacharacters (`%`, `_`) and the escape char itself so a
 * literal symbol-name segment (identifiers routinely contain `_`) matches
 * verbatim under `LIKE … ESCAPE '\'`. Without this, `status_scope` would match
 * `statusXscope`.
 */
export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
