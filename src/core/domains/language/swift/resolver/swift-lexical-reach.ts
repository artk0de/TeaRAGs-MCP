/**
 * What an UNQUALIFIED name can denote at a call site (bd tea-rags-mcp-y99pg.39).
 *
 * Swift resolves a bare `name(…)` lexically: the members of each type
 * enclosing the caller — declared, inherited, conformed, and those a
 * `where Self: Q` re-opening adds — innermost first, then module scope. A
 * member of any other type is not in that lookup at all: from outside
 * `AppIconArt`, `colour(…)` never names `AppIconArt.colour`, and inside a type
 * that conforms to no stream protocol, `close(fd)` is Darwin's `close`, not a
 * project stream's.
 *
 * So a definition is REACHED when it is
 *
 *   - declared at module scope (a free function, a top-level type), or
 *   - a type declaration — construction; nested-type visibility is the caller's
 *     own filter (`lookupSwiftBareNameDefinitions`), or
 *   - a member of a type on some enclosing type's member lookup, or of a
 *     `Self` constraint in force at the call's line, or
 *   - a local function of the function the caller sits in.
 *
 * Any other member is OFF the lookup only where the run proves it: an owner
 * the project declares, or an SDK type the project re-opens while every
 * enclosing type's supertypes are on record. An owner the run says nothing
 * about is UNPROVEN. The two questions read the three states differently: an
 * edge rests only on what is reached, a site leaves the denominator only when
 * everything is off. An index with no `typeDeclarations` channel answers
 * neither, and every definition stands as before.
 */

import type { CallContext, CallRef, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { swiftSpelledNominal } from "../vocabulary/swift-type-text.js";
import { swiftEnclosingTypeIds } from "./swift-enclosing-scope.js";
import type { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { swiftDeclaringFiles, swiftSelfConstraintsAt } from "./swift-type-declarations.js";
import { isSwiftTypeDeclarationId, isSwiftTypeName } from "./swift-type-name.js";

/** Where a definition stands against a bare call's lexical lookup. */
type SwiftLexicalReach = "reached" | "off" | "unproven";

/**
 * The subset of `defs` a bare `call` MAY land on — every definition the run
 * cannot prove off the lookup. The denominator question: a site keeps its
 * charge while any in-project target remains possible.
 */
export function swiftLexicallyReachableDefinitions(
  defs: readonly SymbolDefinition[],
  call: CallRef,
  ctx: CallContext,
  memberTypes: SwiftMemberTypeLookup,
): SymbolDefinition[] {
  if (ctx.typeDeclarations === undefined) return [...defs];
  const reach = swiftLexicalReachClassifier(call, ctx, memberTypes);
  return defs.filter((def) => reach(def) !== "off");
}

/**
 * The subset of `defs` the lookup provably REACHES. The resolution question:
 * an edge never rests on an owner the run says nothing about.
 */
export function swiftLexicallyReachedDefinitions(
  defs: readonly SymbolDefinition[],
  call: CallRef,
  ctx: CallContext,
  memberTypes: SwiftMemberTypeLookup,
): SymbolDefinition[] {
  if (ctx.typeDeclarations === undefined) return [...defs];
  const reach = swiftLexicalReachClassifier(call, ctx, memberTypes);
  return defs.filter((def) => reach(def) === "reached");
}

function swiftLexicalReachClassifier(
  call: CallRef,
  ctx: CallContext,
  memberTypes: SwiftMemberTypeLookup,
): (def: SymbolDefinition) => SwiftLexicalReach {
  const enclosing = swiftEnclosingTypeIds(ctx);
  const lookups = [
    ...enclosing,
    ...(enclosing.length > 0 ? swiftSelfConstraintsAt(enclosing[0], call.startLine, ctx) : []),
  ];
  const reached = new Set<string>();
  for (const typeName of lookups) {
    for (const type of memberTypes.memberReach(typeName, call.member, ctx).types) reached.add(type);
  }
  const hierarchiesKnown = enclosing.every(
    (typeName) => (swiftDeclaringFiles(typeName, ctx)?.size ?? 0) > 0 || memberTypes.isSdkType(typeName),
  );
  return (def) => {
    if (def.scope.length === 0 || isSwiftTypeDeclarationId(def.symbolId)) return "reached";
    if (!isSwiftTypeName(lastComponent(def.scope[def.scope.length - 1]))) return localReach(def, ctx);
    const owner = def.scope.join(".");
    if (reached.has(owner)) return "reached";
    const declaring = swiftDeclaringFiles(owner, ctx);
    // The run says nothing about the owner: nothing is proven.
    if (declaring === undefined) return "unproven";
    // A type the project declares, off every enclosing lookup: a namesake.
    if (declaring.size > 0) return "off";
    // A re-opened SDK type off the lookups is a namesake only when the SDK
    // substrate knows it and every enclosing type's supertypes are on record.
    return memberTypes.isSdkType(swiftSpelledNominal(owner)) && hierarchiesKnown ? "off" : "unproven";
  };
}

/**
 * A LOCAL declaration — a function nested in a function body, composed under
 * that function (`GitHubTileConfig#init#flag`) — is visible inside its
 * enclosing function and nowhere else: reached from a caller in that function
 * or nested in it, off from every other caller. A call site with no caller id
 * proves nothing. A local composes under its container's BASE name, so an
 * overloaded container's `~N` is read off the caller before the comparison
 * (`GitHubTileConfig#init~2` holds `GitHubTileConfig#init#flag`).
 */
function localReach(def: SymbolDefinition, ctx: CallContext): SwiftLexicalReach {
  if (ctx.callerSymbolId === undefined) return "unproven";
  const caller = ctx.callerSymbolId.replace(/~\d+(?=[#.]|$)/g, "");
  const cut = Math.max(def.symbolId.lastIndexOf("#"), def.symbolId.lastIndexOf("."));
  if (cut <= 0) return "unproven";
  const container = def.symbolId.slice(0, cut).replace(/~\d+(?=[#.]|$)/g, "");
  const inside = caller === container || caller.startsWith(`${container}#`) || caller.startsWith(`${container}.`);
  return inside ? "reached" : "off";
}

/** A scope segment's last `.` component — `extension AFError.Reason` is judged by `Reason`. */
function lastComponent(segment: string): string {
  return segment.slice(segment.lastIndexOf(".") + 1);
}
