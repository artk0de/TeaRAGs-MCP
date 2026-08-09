/**
 * Flow-sensitive local-variable typing — one position-aware binding
 * (`LocalBinding`) plus the two lookups that read a variable's most-recent
 * binding at a call's line. Carried on `ChunkExtraction.localBindings` at
 * extraction time and on `CallContext.localBindings` at resolve time, which is
 * why it sits below both rather than inside either.
 *
 * The lookups live here, not in each language's resolver, so "most recent
 * binding at or before this line" is defined exactly once. Re-exported verbatim
 * by the `codegraph.ts` barrel.
 */

import type { RubyTypeRef } from "./language.js";

/**
 * A single position-aware local-variable type binding: the variable's inferred
 * receiver type, tagged with the 1-based source line where the binding is
 * established. A variable accumulates an array of these (one per assignment /
 * annotation on its path); a call site resolves against the most-recent binding
 * at or before its own line via {@link resolveLocalBindingType}. This makes
 * `var.method()` resolution flow-sensitive — a reassignment to a different type
 * is the correct answer per call site, not a conflict.
 */
export interface LocalBinding {
  /** 1-based source line where this binding is established. */
  line: number;
  /** Inferred receiver type (class / constant name), e.g. "User" or "Acme::Post". */
  type: string;
  /**
   * Whether `type` is held as a CLASS (`var = User` → `var.find` resolves
   * `User.find`, a static method) or an INSTANCE (default; `var = User.new` →
   * `var.save` resolves `User#save`). Absent ⇒ `"instance"` so every existing
   * binding and every other language is unaffected (bd Increment B / var=CONST).
   */
  valueKind?: "instance" | "class";
  /**
   * Richer receiver type when the bare `type` string can't represent it (union /
   * container); engine prefers `typeRef` when present. Added by INFRA-A so
   * union (`[A,B]`) and container (`Array<Post>`) receiver types ride the
   * EXISTING localBindings channel to the propagation engine at resolve time.
   * Absent for plain class/instance bindings (the string `type` is sufficient).
   */
  typeRef?: RubyTypeRef;
}

/**
 * Resolve the most-recent local binding for `varName` at or before `atLine`
 * (the binding with the greatest `line <= atLine`). Returns undefined when the
 * variable has no binding established on or before that line — the resolver then
 * falls through (no local type), preserving the DROP-not-guess discipline.
 *
 * Shared by every language's local-binding resolver AND the language-neutral
 * cone dispatcher so the position-aware lookup is defined exactly once. `<=`
 * (not `<`): a variable's own calls are always on a strictly later line than its
 * binding statement, so `<=` is safe and tolerant of the rare same-line case.
 */
export function resolveLocalBindingType(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
): string | undefined {
  return resolveLocalBinding(bindings, varName, atLine)?.type;
}

/**
 * Resolve the most-recent `LocalBinding` for `varName` at or before `atLine`,
 * returning the full binding (so callers can inspect `valueKind` and other
 * fields). Returns `undefined` when no binding is established on or before that
 * line. Position-aware lookup shared with `resolveLocalBindingType`.
 */
export function resolveLocalBinding(
  bindings: Record<string, LocalBinding[]> | undefined,
  varName: string,
  atLine: number,
): LocalBinding | undefined {
  const list = bindings?.[varName];
  if (!list || list.length === 0) return undefined;
  let best: LocalBinding | undefined;
  for (const binding of list) {
    if (binding.line <= atLine && (best === undefined || binding.line > best.line)) best = binding;
  }
  return best;
}
