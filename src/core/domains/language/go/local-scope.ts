/**
 * Go's scope rule for the per-chunk `localBindings` the walker records — the
 * ONE reading every Go consumer uses in place of the shared
 * `resolveLocalBinding` (bd tea-rags-mcp-e6xx).
 *
 * The shared lookup takes the binding with the greatest `line <= atLine`,
 * skipping one whose `scopeEndLine` is already past. Go adds one rule to it:
 * a local DECLARED BY A STATEMENT (`x, err := f()`, `var x = …`, a range
 * clause, a type-switch alias) is in scope only after that statement ends —
 * "the scope … begins at the end of the ConstSpec or VarSpec (ShortVarDecl
 * for short variable declarations)" (Go spec, Declarations and scope). So in
 * `config, err := config.LoadTwo()` the right-hand `config` is still the
 * imported package. The walker marks such a binding with `endLine`, the
 * statement's last line; a binding without one (a parameter, a receiver, and
 * every typed binding recorded before this rule) is in scope from its `line`,
 * exactly as the shared lookup reads it.
 */

import type { LocalBinding } from "../../../contracts/types/codegraph.js";

/** Whether `binding` is in scope on `atLine`. */
export function goBindingInScopeAt(binding: LocalBinding, atLine: number): boolean {
  if (binding.scopeEndLine !== undefined && atLine > binding.scopeEndLine) return false;
  return binding.endLine === undefined ? binding.line <= atLine : binding.endLine < atLine;
}

/**
 * The binding `name` denotes on `atLine`: of those in scope, the one declared
 * last. `undefined` when no local of that name is in scope — the name then
 * denotes a package, a package-level declaration, or nothing the walker saw.
 */
export function goLocalBindingAt(
  bindings: Readonly<Record<string, LocalBinding[]>> | undefined,
  name: string,
  atLine: number,
): LocalBinding | undefined {
  const list = bindings?.[name];
  if (list === undefined) return undefined;
  let best: LocalBinding | undefined;
  for (const binding of list) {
    if (!goBindingInScopeAt(binding, atLine)) continue;
    if (best === undefined || binding.line > best.line) best = binding;
  }
  return best;
}
