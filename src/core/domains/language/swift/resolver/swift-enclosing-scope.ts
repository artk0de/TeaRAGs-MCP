/**
 * Where a Swift call site sits, read off `callerScope` — the one place the
 * resolver turns a chain of scope NAMES into the types that enclose the caller
 * (bd tea-rags-mcp-3ievc). Shared by the strategies, the chain fold's ports and
 * the member-type lookup, so all three agree on what `self` is.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import { isSwiftTypeName } from "./swift-type-name.js";

/**
 * The TYPES lexically enclosing the caller, innermost first, each as the
 * qualified id its members compose under (bd tea-rags-mcp-3ievc).
 *
 * `callerScope` is the chain of NAMES a declaration sits in — `["Outer",
 * "Inner"]` for a method of a nested type, `["Store", "run"]` for a local
 * function inside `Store#run` — while the members of `Inner` compose as
 * `Outer.Inner#m`. So the enclosing type is never the bare last segment: it is
 * the scope PREFIX, joined with Swift's `.` separator, and only at a depth whose
 * segment names a TYPE. A function segment is skipped, which is what lets a
 * local function (or a closure inside one) reach its type's members — Swift
 * captures `self` there. The type test is the UpperCamelCase guideline this
 * vertical already spends as evidence (`./swift-type-name.ts`); a dotted
 * segment — `extension AFError.Reason` — is judged by its last component.
 */
export function swiftEnclosingTypeIds(ctx: CallContext): string[] {
  const out: string[] = [];
  for (let depth = ctx.callerScope.length; depth > 0; depth--) {
    if (!isTypeSegment(ctx.callerScope[depth - 1])) continue;
    out.push(ctx.callerScope.slice(0, depth).join("."));
  }
  return out;
}

/**
 * The innermost enclosing TYPE's own scope segment — what `self` denotes,
 * spelled the way the walker keys `classFieldTypes` and `classExtends` (the
 * declaration's name text, so `Inner` for a nested type and `AFError.Reason`
 * for an extension of one). Undefined at file scope. Skips function segments
 * for the reason {@link swiftEnclosingTypeIds} states.
 */
export function swiftSelfTypeName(ctx: CallContext): string | undefined {
  for (let depth = ctx.callerScope.length; depth > 0; depth--) {
    const segment = ctx.callerScope[depth - 1];
    if (isTypeSegment(segment)) return segment;
  }
  return undefined;
}

/** Whether a scope segment names a type — judged by its last `.` component. */
function isTypeSegment(segment: string): boolean {
  return isSwiftTypeName(segment.slice(segment.lastIndexOf(".") + 1));
}
