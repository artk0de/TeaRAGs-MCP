/**
 * "Which PROJECT INTERFACES does the type checker say this call's receiver is?"
 * — the one question both halves of bd tea-rags-mcp-hwwtw ask.
 *
 * A member call on an interface-typed receiver used to be decided by global
 * short-name uniqueness. `walkCommits` destructures `diffMemo` out of its
 * options, so the walker binds no type to it, and `diffMemo?.set(...)` reached
 * `globalShortName`: while `CommitDiffMemo#set` was the project's only `set` the
 * pass committed to it, and the moment bd 39xca.6 added `RunScopedMemo#set` the
 * edges vanished — while a unique name kept manufacturing edges for receivers
 * that never reach the project method at all. The declared type was never
 * consulted, and it is the only thing that knows.
 *
 * So the answer is read off the checker and used twice:
 *
 *   - `TSTypeCheckerInterfaceReceiverDispatchResolver` hands each named
 *     interface to the CHA cone as the base type the walker could not supply,
 *     which reaches the classes that `implements` it through the run hierarchy;
 *   - `TSGlobalShortNameSymbolResolutionStrategy` declines a receiver typed this
 *     way, because a receiver-blind short-name match is a naming coincidence
 *     against a type that already names what the member is.
 *
 * Only CONTRACTS qualify — a symbol every declaration of which is an
 * `interface` block, or a type alias of an object type (bd tea-rags-mcp-6ea2k),
 * at least one of them in the project's own sources. A class
 * receiver keeps the answers it had: its members are symbols the table can pin
 * directly, and widening this to classes would re-route every class-typed
 * destructured receiver through the cone. Union and intersection receivers are
 * flattened by {@link typeConstituents}, so `A | B` and `A & B` name both.
 *
 * Every exit that lacks evidence answers `[]`: no Program, no locatable
 * receiver, `any`, an anonymous shape, a dependency's interface. The symbol-table
 * gate comes first for cost, as in the receiver guards beside this module: with
 * no project symbol of the member's name neither consumer could change an edge.
 */

import type ts from "typescript";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { lookupEcmascriptSymbolsByShortName } from "../../shared/ecmascript-symbol-lookup.js";
import { findReceiverExpression } from "./strategies/ts-type-checker-shared.js";
import { loadTypeScriptCompiler } from "./ts-compiler-loader.js";
import type { TSProgramCache } from "./ts-program-cache.js";
import { typeConstituents } from "./ts-type-constituents.js";

export function receiverProjectInterfaceNames(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): readonly string[] {
  const { receiver } = call;
  if (programCache === null || receiver === null || receiver.length === 0) return [];
  if (receiver === "this" || receiver === "super" || call.member.length === 0) return [];
  if (lookupEcmascriptSymbolsByShortName(ctx, call.member, { role: "callee" }).length === 0) return [];
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return [];
  const node = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null) return [];

  const names: string[] = [];
  for (const constituent of typeConstituents(handle.checker, handle.checker.getTypeAtLocation(node))) {
    const symbol = contractSymbolOf(constituent);
    if (symbol === undefined) continue;
    const declarations = symbol.getDeclarations() ?? [];
    if (!declarations.some((declaration) => programCache.isProjectSourceFile(declaration.getSourceFile().fileName))) {
      continue;
    }
    const name = symbol.getName();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The CONTRACT symbol a receiver type names, or `undefined`: an interface
 * (every declaration an `interface` block), or a type alias of an object type
 * (`type StorageAdapter = { read…; write… }`). The 39xca.14 design makes both
 * contracts, and the walker emits both as `structuralContracts` under the
 * declared name. The checker reports the alias's type as an anonymous `__type`
 * literal and names the alias only through `aliasSymbol`, so reading
 * `getSymbol()` alone dropped every alias contract (bd tea-rags-mcp-6ea2k).
 */
function contractSymbolOf(type: ts.Type): ts.Symbol | undefined {
  const ts = loadTypeScriptCompiler();
  const symbol = type.getSymbol();
  const declarations = symbol?.getDeclarations() ?? [];
  if (symbol !== undefined && declarations.length > 0 && declarations.every((d) => ts.isInterfaceDeclaration(d))) {
    return symbol;
  }
  const alias = type.aliasSymbol;
  const aliasDeclarations = alias?.getDeclarations() ?? [];
  if (
    alias !== undefined &&
    aliasDeclarations.length > 0 &&
    aliasDeclarations.every((d) => ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type))
  ) {
    return alias;
  }
  return undefined;
}

/**
 * `true` when the checker types the receiver as project interfaces and
 * `candidate` belongs to none of them — so a short-name match on it would be
 * decided by the name alone.
 *
 * A candidate is consistent with the declared type when its owner IS one of
 * those interfaces (a member the table carries under the interface's own name)
 * or an owner the run hierarchy records descending from one, transitively.
 * Anything else — an unrelated class that happens to own the project's only
 * `set`, a top-level function named like the member — has no evidence behind it
 * but its name.
 *
 * "Descending" includes the `structural` rows the barrier derives (bd
 * tea-rags-mcp-39xca.14): a class or object-literal factory carrying every
 * required member of the interface is its descendant without an `implements`
 * clause. The derivation reads the symbol table and the hydrated contracts, not
 * the caller's Program, so the edge set does not depend on how the run was
 * scheduled.
 */
export function interfaceReceiverExcludesCandidate(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
  candidate: Pick<SymbolDefinition, "scope">,
): boolean {
  const interfaces = receiverProjectInterfaceNames(call, ctx, programCache);
  if (interfaces.length === 0) return false;
  const owner = candidate.scope.at(-1);
  if (owner === undefined) return true;
  return !interfaces.some(
    (name) =>
      name === owner ||
      (ctx.hierarchy?.getDescendants(name, { transitive: true }).some((edge) => edge.sourceFqName === owner) ?? false),
  );
}
