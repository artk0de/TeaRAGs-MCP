/**
 * Symbol lookups restricted to SWIFT declarations — the ONLY table entry points
 * the Swift resolver may use (`.claude/rules/resolver-architecture.md` §2).
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES` extension
 * and `SymbolDefinition` carries no `language` field, so a bare
 * `lookup("Store#save")` answers with any file that declares that id. Swift
 * makes this sharper than most: an iOS repository ordinarily ships a
 * TypeScript or Ruby backend beside it, and Swift's member vocabulary —
 * `init`, `run`, `format`, `value`, `description` — collides with those
 * languages constantly. It goes wrong both ways: a PICK SITE selects the
 * foreign method outright, and a CARDINALITY GATE reads a foreign namesake as
 * ambiguity and drops a real Swift edge.
 *
 * Wrapping the table rather than filtering per site is what keeps the guard
 * from being forgotten at the next one. The extension is the axis for the same
 * reason as Go's, Python's and Ruby's helpers: it is all a definition carries.
 *
 * The short-name entry point carries a second guard for the same reason —
 * {@link collapseReopenedTypeDeclarations}, which folds the several
 * declarations of ONE re-opened Swift type back into one candidate.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
  type SymbolLookupOptions,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import { swiftEnclosingTypeIds } from "./swift-enclosing-scope.js";
import { swiftDeclaringFiles } from "./swift-type-declarations.js";
import { hasSwiftOverloadSuffix, isSwiftTypeDeclarationId, stripSwiftOverloadSuffix } from "./swift-type-name.js";

const SWIFT_SOURCE_EXTENSION = ".swift";

/** Whether a definition's file is Swift source. */
export function isSwiftSourcePath(relPath: string): boolean {
  return relPath.endsWith(SWIFT_SOURCE_EXTENSION);
}

/** Exact-id lookup (`Store`, `Store#save`, `Store.make`) over Swift declarations only. */
export function lookupSwiftSymbols(ctx: CallContext, symbolId: string): SymbolDefinition[] {
  return keepDeclaringFiles(
    ctx.symbolTable.lookup(symbolId).filter((def) => isSwiftSourcePath(def.relPath)),
    ctx,
  );
}

/**
 * Short-name lookup over Swift declarations only, with a type re-opened in one
 * file counted ONCE.
 */
export function lookupSwiftSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  const swiftDefs = ctx.symbolTable.lookupByShortName(name, options).filter((def) => isSwiftSourcePath(def.relPath));
  return keepDeclaringFiles(collapseReopenedTypeDeclarations(swiftDefs), ctx);
}

/**
 * The declarations an UNQUALIFIED name can denote at the call site
 * (bd tea-rags-mcp-y99pg.15): the short-name hits minus every NESTED type
 * whose container does not enclose the caller. Swift resolves a bare `Result`
 * lexically, so `PathMonitor.Result` is invisible from `WebSocketRequest` and
 * the name there is the standard library's `Result` — which the project may
 * extend. Members and top-level declarations are kept as they were.
 */
export function lookupSwiftBareNameDefinitions(ctx: CallContext, name: string): SymbolDefinition[] {
  const enclosing = swiftEnclosingTypeIds(ctx);
  return lookupSwiftSymbolsByShortName(ctx, name).filter((def) => nestedTypeVisible(def.symbolId, enclosing));
}

function nestedTypeVisible(symbolId: string, enclosing: readonly string[]): boolean {
  if (!isSwiftTypeDeclarationId(symbolId)) return true;
  const base = stripSwiftOverloadSuffix(symbolId);
  const cut = base.lastIndexOf(".");
  if (cut < 0) return true;
  const container = base.slice(0, cut);
  return enclosing.some((id) => id === container || id.startsWith(`${container}.`));
}

/**
 * Drop the re-openings of a type re-opened ACROSS files (bd tea-rags-mcp-y99pg.1).
 *
 * `World.swift` declares `World` and `World+DSL.swift` extends it: both compose
 * the id `World`, and the cardinality gate reads one logical type as two. The
 * run's `typeDeclarations` channel names the file holding the declaration, and
 * only a TYPE id is narrowed — a member (`World#run`) is declared where it is
 * declared, extension or not. A type the project only re-opens keeps every
 * re-opening here: whether such a type is a target at all is a question for the
 * construction site (`isSwiftReopenedOnlyType`), not for a lookup that also
 * serves `World.shared`-style class heads. No channel, no narrowing.
 */
function keepDeclaringFiles(defs: SymbolDefinition[], ctx: CallContext): SymbolDefinition[] {
  if (ctx.typeDeclarations === undefined || defs.length < 2) return defs;
  return defs.filter((def) => {
    if (!isSwiftTypeDeclarationId(def.symbolId)) return true;
    const declaring = swiftDeclaringFiles(stripSwiftOverloadSuffix(def.symbolId), ctx);
    return declaring === undefined || declaring.size === 0 || declaring.has(def.relPath);
  });
}

/**
 * Drop the extra declarations a same-file `extension` adds to ONE type
 * (bd tea-rags-mcp-sg35c).
 *
 * tree-sitter-swift parses `extension Invoice` as a second `class_declaration`
 * carrying the extended type's name, so a file holding `struct Invoice` beside
 * `extension Invoice: Codable` composes `Invoice` AND `Invoice~2`. Its MEMBERS
 * are already attributed correctly — `collectSymbols` scopes them under
 * `Invoice`, never `Invoice~2` — and only the extension's own container node
 * gets a second id. `lastSegment` strips the `~N`, so both answer the short
 * name `Invoice`, and the strict cardinality gate then reads one logical type
 * as ambiguity and drops every construction edge into it. Same-file conformance
 * extensions are ordinary Swift, so that is a real cost on any corpus.
 *
 * The fold is deliberately narrow, and each condition is load-bearing:
 *
 *   - **Only a `~N`-suffixed id is ever dropped.** The base declaration — the
 *     one carrying the type's own body — is what survives.
 *   - **Only when the base id is in the SAME FILE.** Two files each declaring
 *     `Invoice` are a genuine cross-file ambiguity (a type and an extension in
 *     separate files compose the identical id, and nothing here says which is
 *     which), so they stay ambiguous and emit no edge.
 *   - **Only when the base id names a TYPE** ({@link isSwiftTypeDeclarationId}).
 *     `Invoice#init` / `Invoice#init~2` and `Invoice.empty` / `Invoice.empty~2`
 *     are genuine overloads with distinct bodies — collapsing them to the first
 *     would be a coin flip, which is exactly what `disambiguateOverloads` was
 *     turned on to avoid.
 *
 * So this removes a DUPLICATE, it does not pick a winner: after the fold the
 * cardinality gate still sees every distinct declaration the file holds.
 */
function collapseReopenedTypeDeclarations(defs: SymbolDefinition[]): SymbolDefinition[] {
  return defs.filter((def) => {
    if (!hasSwiftOverloadSuffix(def.symbolId) || !isSwiftTypeDeclarationId(def.symbolId)) return true;
    const base = stripSwiftOverloadSuffix(def.symbolId);
    return !defs.some((other) => other.symbolId === base && other.relPath === def.relPath);
  });
}

/**
 * Resolve `<typeName>#<member>` (instance) then `<typeName>.<member>` (static /
 * class) over Swift declarations. Instance first because Swift's type members
 * are overwhelmingly instance-level and a static namesake is the rarer shape.
 */
export function lookupSwiftTypeMember(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  call?: CallRef,
): SymbolResolutionTarget | null {
  for (const id of [`${typeName}#${member}`, `${typeName}.${member}`]) {
    const hit = pickSwiftOverload(swiftMemberCandidates(ctx, id, call), mode);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}

/**
 * The declarations of member id `id` a call can reach: the id itself when the
 * call carries no signature evidence (every pre-label shape), else the id and
 * its same-file overloads (`id~2`, …) narrowed to the ones whose labels,
 * unlabelled count and closure acceptance fit the call
 * ({@link narrowSwiftOverloads}).
 */
export function swiftMemberCandidates(ctx: CallContext, id: string, call?: CallRef): SymbolDefinition[] {
  if (call?.argCount === undefined) return lookupSwiftSymbols(ctx, id);
  return narrowSwiftOverloads(call, lookupSwiftOverloads(ctx, id));
}

/** `id` and every same-file overload `id~N` of it — the suffixes are contiguous per file. */
export function lookupSwiftOverloads(ctx: CallContext, id: string): SymbolDefinition[] {
  const out = lookupSwiftSymbols(ctx, id);
  for (let n = 2; n <= SWIFT_MAX_OVERLOADS; n++) {
    const more = lookupSwiftSymbols(ctx, `${id}~${n}`);
    if (more.length === 0) break;
    out.push(...more);
  }
  return out;
}

/** A cap on the `~N` probe, far above any overload set a real type declares. */
const SWIFT_MAX_OVERLOADS = 64;

/**
 * Keep the declarations a call's argument labels can reach (bd
 * tea-rags-mcp-y99pg.7), over the signature the Swift walker maps labels onto:
 * labelled parameters as keywords (`kwargs`), unlabelled ones as positional
 * slots (`arity`), closure acceptance as `acceptsBlock`. A declaration with no
 * recorded signature is kept — missing evidence never drops, as in every
 * kernel narrower.
 */
export function narrowSwiftOverloads(call: CallRef, defs: SymbolDefinition[]): SymbolDefinition[] {
  if (call.argCount === undefined) return defs;
  return defs.filter((def) => swiftCallFits(call, def));
}

/**
 * Whether `def` can be the target of `call`:
 *
 *   - every label the call writes is one the declaration declares, and it
 *     takes no fewer unlabelled arguments than the call passes (unless
 *     variadic);
 *   - a trailing closure needs a parameter that can take one — a declaration
 *     PROVEN to have none cannot be the target. Ruby's `BlockNarrower` only
 *     prefers, because Ruby ignores an unused block; Swift rejects the call;
 *   - every requirement is met, except that a trailing closure may stand in
 *     for ONE: the walker keeps a parameter whose type may be a closure
 *     typealias (`_ closure: QuickConfigurer`) required, since only a proven
 *     closure type can be declared optional up front.
 */
function swiftCallFits(call: CallRef, def: SymbolDefinition): boolean {
  const argCount = call.argCount ?? 0;
  const keys = call.kwargKeys ?? [];
  if (call.passesBlock && def.acceptsBlock === false) return false;
  let missing = 0;
  if (def.kwargs !== undefined) {
    const declared = new Set([...def.kwargs.required, ...(def.kwargs.optional ?? [])]);
    if (!keys.every((key) => declared.has(key))) return false;
    missing += def.kwargs.required.filter((label) => !keys.includes(label)).length;
  }
  if (def.arity !== undefined) {
    if (!def.arity.hasSplat && argCount > def.arity.maxPositional) return false;
    missing += Math.max(0, def.arity.minRequired - argCount);
  }
  return missing <= (call.passesBlock ? 1 : 0);
}

/**
 * One declaration from a narrowed overload set: the unsuffixed declarations
 * first (the pick every lookup made before labels were read), and among
 * declarations of ONE file the first — a file's `id` / `id~2` are the same
 * member's overloads, not an ambiguity about where it lives. Across files the
 * cardinality gate decides, as it always has.
 */
function pickSwiftOverload(defs: SymbolDefinition[], mode: AmbiguousResolveMode): SymbolDefinition | null {
  const unsuffixed = defs.filter((def) => !hasSwiftOverloadSuffix(def.symbolId));
  const pool = unsuffixed.length > 0 ? unsuffixed : defs;
  if (pool.length > 1 && pool.every((def) => def.relPath === pool[0].relPath)) return pool[0];
  return pickSingleCandidate(pool, mode);
}

/**
 * The composed id a type NAME denotes at the call site — the name as a walker
 * fact WROTE it (`let token: CancellationToken`) against the id its members
 * compose under (`DataStreamRequest.CancellationToken#cancel`).
 *
 * Swift resolves a written type name lexically, and this follows that as far
 * as the index can:
 *
 *   1. a declaration composed under the name itself — a top-level type, or a
 *      name that already arrives qualified — is what the name means;
 *   2. otherwise the TYPE declarations nested under some other type whose own
 *      last segment is the name (`<Outer>.CancellationToken`). One such
 *      declaration is the answer; several are narrowed to those nested inside
 *      a type ENCLOSING THE CALLER, innermost first — `State` written in
 *      `Request` is `Request.State`, not `Socket.State`;
 *   3. anything still ambiguous answers `undefined`, and the name is looked up
 *      as written, which finds nothing.
 *
 * The narrowing reads the caller's scope, not the scope the fact was WRITTEN
 * in, because that is all a call site carries. The two coincide for the shapes
 * that dominate — a property typed by a sibling nested type, a local typed by
 * the enclosing type's own nested state — and where they do not, several
 * namesakes and no enclosing one leave the answer at `undefined`.
 */
export function qualifySwiftTypeName(typeName: string, ctx: CallContext): string {
  if (lookupSwiftSymbols(ctx, typeName).length > 0) return typeName;
  const suffix = `.${typeName}`;
  const shortName = typeName.slice(typeName.lastIndexOf(".") + 1);
  const nested = new Set<string>();
  for (const def of lookupSwiftSymbolsByShortName(ctx, shortName)) {
    const base = stripSwiftOverloadSuffix(def.symbolId);
    if (base.endsWith(suffix) && isSwiftTypeDeclarationId(base)) nested.add(base);
  }
  if (nested.size === 1) return [...nested][0];
  for (const enclosing of swiftEnclosingTypeIds(ctx)) {
    const qualified = `${enclosing}${suffix}`;
    if (nested.has(qualified)) return qualified;
  }
  return typeName;
}

/**
 * The composed id a type name WRITTEN INSIDE `owner` denotes: Swift's lexical
 * lookup from that declaration outward — `<owner>.<name>`, then each enclosing
 * type of `owner` in turn — before {@link qualifySwiftTypeName}'s module-level
 * and caller-scope reading.
 *
 * `owner` is the qualified id of the type whose declaration spelled the name
 * (the type declaring a property, for a property's type). The innermost match
 * wins, as it does in Swift: a `State` nested in `Request` shadows a top-level
 * `State` for everything written inside `Request`.
 */
export function qualifySwiftTypeNameWithin(typeName: string, owner: string, ctx: CallContext): string {
  for (let scope = owner; scope.length > 0; scope = scope.slice(0, Math.max(0, scope.lastIndexOf(".")))) {
    const qualified = `${scope}.${typeName}`;
    if (lookupSwiftSymbols(ctx, qualified).length > 0) return qualified;
    if (!scope.includes(".")) break;
  }
  return qualifySwiftTypeName(typeName, ctx);
}
