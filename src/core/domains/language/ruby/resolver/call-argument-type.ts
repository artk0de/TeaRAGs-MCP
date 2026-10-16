/**
 * The static type of one call ARGUMENT (bd tea-rags-mcp-2m83f.44 / .49) — the
 * evidence a callee's parameter is typed from by its callers.
 *
 * - A canonical literal the walker wrote (`0`, `0.0`, `""`, `:_`, `[]`, `{}`)
 *   is an instance of its core class. It counts as typed evidence: a parameter
 *   one caller passes `Invoice` and another `42` is polymorphic, and reading
 *   the literal as untyped would let the `Invoice` caller type it alone.
 * - A constant path the project declares as a class or module is that class, in
 *   class form (`perform(Firm)` → `Firm`), looked up like Ruby does from the
 *   caller's nesting. A value constant or an undeclared one is untyped.
 * - Anything else is typed as a receiver of that text would be.
 */

import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { rubyConstantDeclarers, typeOfReceiver } from "./strategies/index.js";

const LITERAL_CLASS: ReadonlyMap<string, string> = new Map([
  ["0", "Integer"],
  ["0.0", "Float"],
  ['""', "String"],
  [":_", "Symbol"],
  ["[]", "Array"],
  ["{}", "Hash"],
]);

const CONSTANT_PATH = /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/;

export function typeOfRubyCallArgument(expr: string, call: CallRef, ctx: CallContext): RubyTypeRef | undefined {
  const literal = LITERAL_CLASS.get(expr);
  if (literal !== undefined) return { form: "instance", name: literal };
  if (CONSTANT_PATH.test(expr)) return constantArgumentType(expr.replace(/^::/, ""), ctx);
  return typeOfReceiver(expr, call.startLine, ctx, call.startColumn);
}

/** The class or module a constant argument names, in class form; `undefined` for a value or undeclared constant. */
function constantArgumentType(path: string, ctx: CallContext): RubyTypeRef | undefined {
  const declared = rubyConstantDeclarers(path, ctx);
  if (declared === null) return undefined;
  const isType = ctx.symbolTable
    .lookup(declared.fq)
    .some((def) => def.symbolKind === undefined || def.symbolKind === "class" || def.symbolKind === "module");
  return isType ? { form: "class", name: declared.fq } : undefined;
}
