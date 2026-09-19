/**
 * Go's scope rule for the per-chunk locals the walker records — the ONE
 * reading every Go consumer uses in place of the shared `resolveLocalBinding`
 * (bd tea-rags-mcp-e6xx).
 *
 * The shared lookup takes the binding with the greatest `line <= atLine`,
 * skipping one whose `scopeEndLine` is already past. Go adds one rule to it:
 * a local DECLARED BY A STATEMENT (`x, err := f()`, `var x = …`, a range
 * clause, a type-switch alias, `x := New()`) is in scope only after that
 * statement ends — "the scope … begins at the end of the ConstSpec or VarSpec
 * (ShortVarDecl for short variable declarations)" (Go spec, Declarations and
 * scope). So in `config, err := config.LoadTwo()` the right-hand `config` is
 * still the imported package. The walker marks such a binding with `endLine`,
 * the statement's last line — but only when the right-hand side names the
 * declared identifier (`goDeclarationEndLine`): a call site has no column, so
 * the bound would otherwise hide an `if e := New(); e.Ok() {` header's local
 * from the rest of its own line. A binding without one (a parameter, a
 * receiver, a header's init declaration, and every typed binding) is in scope
 * from its `line`, exactly as the shared lookup reads it.
 *
 * A Go local lives on one of two channels: `localBindings` (typed, or EMPTY
 * for a value no pass can type) and `callResultBindings` (`x := New()`, typed
 * at resolve time through the callee's declared return type). `goLocalAt`
 * reads both and answers with the one declared LAST among those in scope —
 * the innermost declaration of the name, which is the one the compiler binds.
 */

import type { CallResultBinding, LocalBinding } from "../../../contracts/types/codegraph.js";

/** The position fields both binding channels share. */
interface GoScopedPosition {
  readonly line: number;
  readonly endLine?: number;
  readonly scopeEndLine?: number;
}

/** The binding channels a Go local may live on — a `ChunkExtraction` or a `CallContext`. */
export interface GoLocalChannels {
  readonly localBindings?: Readonly<Record<string, LocalBinding[]>>;
  readonly callResultBindings?: Readonly<Record<string, CallResultBinding[]>>;
  /**
   * The chunk-wide call binding (bd tea-rags-mcp-6g9c) — Ruby's channel and the
   * one Go's walker wrote before call bindings carried a position. An entry
   * here is read as a call binding in scope on every line, below any
   * positional local of the same name.
   */
  readonly localCallBindings?: Readonly<Record<string, string>>;
}

/**
 * What a name denotes on a line: a value binding (typed, or `""` for unknown)
 * or a call-result binding — with the line of its declaration, where its
 * callee is evaluated, `undefined` for a chunk-wide binding that carries none.
 */
export type GoLocalAtLine =
  | { readonly kind: "value"; readonly binding: LocalBinding }
  | { readonly kind: "call"; readonly callee: string; readonly line?: number };

/** Whether `position` is in scope on `atLine`. */
export function goBindingInScopeAt(position: GoScopedPosition, atLine: number): boolean {
  if (position.scopeEndLine !== undefined && atLine > position.scopeEndLine) return false;
  return position.endLine === undefined ? position.line <= atLine : position.endLine < atLine;
}

/** Of the positions in scope on `atLine`, the one declared last. */
function latestInScope<T extends GoScopedPosition>(list: readonly T[] | undefined, atLine: number): T | undefined {
  if (list === undefined) return undefined;
  let best: T | undefined;
  for (const position of list) {
    if (!goBindingInScopeAt(position, atLine)) continue;
    if (best === undefined || position.line > best.line) best = position;
  }
  return best;
}

/**
 * The `localBindings` entry `name` denotes on `atLine`: of those in scope, the
 * one declared last. `undefined` when none is in scope.
 */
export function goLocalBindingAt(
  bindings: Readonly<Record<string, LocalBinding[]>> | undefined,
  name: string,
  atLine: number,
): LocalBinding | undefined {
  return latestInScope(bindings?.[name], atLine);
}

/**
 * The local `name` denotes on `atLine`, across both channels — `undefined`
 * when no local of that name is in scope, so the name denotes a package, a
 * package-level declaration, or nothing the walker saw.
 */
export function goLocalAt(channels: GoLocalChannels, name: string, atLine: number): GoLocalAtLine | undefined {
  const value = goLocalBindingAt(channels.localBindings, name, atLine);
  const call = latestInScope(channels.callResultBindings?.[name], atLine);
  if (value !== undefined && (call === undefined || value.line > call.line)) return { kind: "value", binding: value };
  if (call !== undefined) return { kind: "call", callee: call.callee, line: call.line };
  const chunkWide = channels.localCallBindings?.[name];
  return chunkWide === undefined ? undefined : { kind: "call", callee: chunkWide };
}
