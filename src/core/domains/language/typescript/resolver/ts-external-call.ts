/**
 * "Does this call site leave the project?" — the TypeScript answer, in one
 * place (bd tea-rags-mcp-ykj7, hoisted out of `TSCallResolver` for
 * bd tea-rags-mcp-6b3gj).
 *
 * It used to be a private method on the resolver, reachable only through
 * `TSCallResolver#targetsExternalImport`, and the provider called it only on
 * calls the chain had ALREADY declined — a post-hoc miss classifier. That
 * ordering is what produced the defect this module exists to fix: the
 * short-name passes (`globalShortName`, `importNarrowedFallback`) match a bare
 * member name against the whole symbol table, so `arr.push()` resolved to
 * whatever single project symbol happened to be called `push` LONG before
 * anything asked whether the receiver was an Array. The classifier never ran,
 * because from the chain's point of view the call had succeeded.
 *
 * The same predicate now runs BEFORE those two passes as a guard, so one
 * definition answers both questions — whether to emit an edge, and whether the
 * call belongs in the internal `resolveSuccessRate` denominator. Keeping them
 * in sync matters: a call we decline BECAUSE it targets `Array.prototype.push`
 * must also be counted external, or the resolver is penalised for being right.
 */

import { resolveLocalBindingType, type CallContext, type CallRef } from "../../../../contracts/types/codegraph.js";
import {
  ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS,
  ECMASCRIPT_BUILTIN_TYPES,
  ECMASCRIPT_GLOBALS,
} from "../../shared/ecmascript-globals.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

/**
 * `true` when the call provably — or, for an untyped receiver, near-certainly —
 * targets something outside the project. Four cases:
 *
 *   1. the receiver is an ECMAScript ambient global (`Math.max`, `console.log`
 *      — no import to match);
 *   2. the receiver / member binds to an import whose specifier does NOT map to
 *      a project file (`node:fs`, bare npm packages) — `mapImportToFile`
 *      returns `null` for exactly those (relative + tsconfig-`paths` resolve);
 *   3. the receiver's declared TYPE is an ECMAScript runtime builtin (`Map`,
 *      `Set`, `Promise`, typed arrays, …): `m.get()`, `this.pending.set()`,
 *      `p.then()` target the JS runtime instance method, not an in-repo symbol;
 *   4. the receiver carries NO type information at all AND the member is a word
 *      from the builtin-only prototype vocabulary (`push`, `splice`, `flatMap`,
 *      …) — see {@link ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS} for why that set
 *      is deliberately small.
 *
 * PRECISION: cases 3 and 4 are mutually exclusive BY CONSTRUCTION, and that is
 * the load-bearing detail. A receiver whose type IS known decides the question
 * outright — a project-typed receiver is internal even when its member is
 * called `push`, and never falls through to the vocabulary. Case 4 only ever
 * sees receivers nothing in the chain could type.
 */
export function targetsExternalImport(call: CallRef, ctx: CallContext, tsOptions: TsCompilerOptions): boolean {
  // `?? null` rather than a bare destructure: this now runs on EVERY call
  // reaching the short-name passes, not only on the ones already known to have
  // a receiver, and a free call carries no receiver at all.
  const receiver = call.receiver ?? null;
  if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
  // Receiver-bound external, or a bare named import called directly
  // (`import { readFile } from "node:fs"` → `readFile()`).
  const boundName = receiver ?? call.member;
  if (boundName.length === 0) return false;
  for (const imp of ctx.imports) {
    if (imp.importedNames?.includes(boundName) && mapImportToFile(imp.importText, ctx.callerFile, tsOptions) === null) {
      return true;
    }
  }
  return receiverIsBuiltinInstance(call, ctx);
}

/**
 * Cases 3 and 4 of {@link targetsExternalImport}: is the RECEIVER a JS runtime
 * builtin instance?
 *
 * A known type answers definitively — builtin name means external, anything
 * else (a project class, a TS utility type like `Record`) means internal. Only
 * when no type can be resolved does the member-name vocabulary get a vote, and
 * then only for words that carry no comparably-common project meaning.
 *
 * `this` / `super` receivers are excluded outright: those are self- and
 * inherited calls that earlier passes own, and a class with a method named
 * `push` is an ordinary thing to write.
 */
function receiverIsBuiltinInstance(call: CallRef, ctx: CallContext): boolean {
  const receiver = call.receiver ?? null;
  if (receiver === null || receiver.length === 0 || receiver === "this" || receiver === "super") return false;
  const typeName = receiverTypeName(call, ctx);
  if (typeName !== undefined) return ECMASCRIPT_BUILTIN_TYPES.has(typeName);
  return ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS.has(call.member);
}

/**
 * The receiver's declared type name, or `undefined` when nothing in the walker's
 * output pins one.
 *
 *   - `this.<field>.x()` → field type from `ctx.classFieldTypes[scope][field]`
 *     (mirrors `TSFieldTypeSymbolResolutionStrategy`); a chained
 *     `this.a.b.x()` is out of scope (one level only).
 *   - bare `<name>.x()` → walker-bound local type via `resolveLocalBindingType`
 *     (mirrors `TSLocalBindingSymbolResolutionStrategy`).
 */
function receiverTypeName(call: CallRef, ctx: CallContext): string | undefined {
  const receiver = call.receiver ?? "";
  if (receiver.startsWith("this.")) {
    const fieldSegment = receiver.slice("this.".length);
    if (fieldSegment.includes(".") || ctx.callerScope.length === 0) return undefined;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    return ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
  }
  return resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) ?? undefined;
}
