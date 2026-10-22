/** Rust nominal type member lookup for the reusable kernel receiver strategies. */

import type { AmbiguousResolveMode, CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import {
  createTypeMemberLookup,
  RunScopedMemo,
  type NominalTypeRef,
  type TypeMemberLookup,
} from "../../kernel/index.js";
import { rustDerefTarget, rustExactMember } from "./declared-return-type.js";
import { rustCrateRootOf, rustCrateUniqueType } from "./rust-crate-scope.js";
import { rustStdSmartPointerTarget, rustThroughSmartPointers } from "./std-type-hops.js";
import { lookupRustSymbolsByShortName, pickSameFileThenSingle } from "./strategies/shared.js";

/**
 * Rust's `Type::member` and `receiver.member` share the same nominal member
 * table. The symbol-id convention distinguishes instance (`#`) and associated
 * (`.`) members; lookup keeps the historical instance-first order and prefers
 * a same-file declaration when a type name is duplicated across crates.
 *
 * A member every owner misses derefs: Rust's own method resolution follows
 * `Deref` targets, so `d.paint()` on a project `Dom<Window>` resolves on
 * `Window` (bd tea-rags-mcp-2g2og). Three hops with a name cycle guard —
 * `Root<Dom<T>>` derefs twice; `member === "deref"` never walks itself.
 */
export function createRustTypeMemberLookup(mode: AmbiguousResolveMode): TypeMemberLookup {
  return createTypeMemberLookup((typeRef, member, ctx) => resolveRustNominalMember(typeRef, member, ctx, mode));
}

/** The raw nominal-member walk (auto-deref included) for callers outside the kernel strategies. */
export function resolveRustMemberWithDeref(
  typeRef: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): { targetRelPath: string; targetSymbolId: string } | null {
  return resolveRustNominalMember(typeRef, member, ctx, mode);
}

function resolveRustNominalMember(owner: NominalTypeRef, member: string, ctx: CallContext, mode: AmbiguousResolveMode) {
  let current = owner;
  for (let hop = 0; hop < 3; hop++) {
    const hit = resolveRustNominalMemberOn(current, member, ctx, mode);
    if (hit !== null) return hit;
    if (member === "deref") return null;
    // A std smart pointer (`Arc<Core>`) derefs to its target for every member
    // it does not answer itself (bd tea-rags-mcp-2g2og.24).
    const pointee = rustStdSmartPointerTarget(current, member);
    const next = pointee?.form === "instance" ? pointee : rustDerefTarget(current, ctx);
    if (next === undefined || next.name === current.name) return null;
    current = next;
  }
  return null;
}

/**
 * The member a typed PATTERN receiver's miss still reaches (bd
 * tea-rags-mcp-s3i8m Task 1d), or `null`. Two readings the nominal walk
 * leaves out:
 *   - a std smart pointer whose own member (`clone`, `as_ref`, …) the walk
 *     stops on: the pointee's own declaration of that member answers
 *     (`err.clone()` on `Box<Error>` with `impl Clone for Error`);
 *   - a project trait's PROVIDED method on a type that implements the trait
 *     (`impl FormControl for HTMLInputElement {}` → `FormControl#to_element`).
 * Anything not proven answers `null`, and the call keeps its typed-miss verdict.
 */
export function resolveRustTypedMissMember(
  type: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): { targetRelPath: string; targetSymbolId: string } | null {
  const pointee = rustThroughSmartPointers(type);
  if (pointee.form !== "instance") return null;
  if (pointee !== type) {
    const hit = resolveRustNominalMember(pointee, member, ctx, mode);
    if (hit !== null) return hit;
  }
  const provided = rustTraitProvidedMember(pointee, member, ctx);
  return provided === undefined ? null : { targetRelPath: provided.relPath, targetSymbolId: provided.symbolId };
}

/**
 * The sole provided method `member` of a project trait the placed `owner`
 * implements, read off the `implements` hierarchy (keyed by short name). The
 * owner must be the unique type of its name in its crate, and the trait a
 * project `interface`. A trait outside the owner's crate counts only when no
 * other project type shares the owner's name: the hierarchy cannot tell two
 * namesakes' impls apart.
 */
function rustTraitProvidedMember(
  owner: NominalTypeRef,
  member: string,
  ctx: CallContext,
): SymbolDefinition | undefined {
  const boundary = owner.name.indexOf(".rs::");
  if (boundary < 0 || ctx.hierarchy === undefined) return undefined;
  const relPath = owner.name.slice(0, boundary + 3);
  const typeName = owner.name
    .slice(boundary + 5)
    .split("::")
    .at(-1);
  const root = rustCrateRootOf(relPath, ctx);
  if (typeName === undefined || root === undefined) return undefined;
  if (rustCrateUniqueType(typeName, root, ctx)?.relPath !== relPath) return undefined;
  const traits = new Set(
    ctx.hierarchy
      .getAncestors(typeName, { kinds: ["implements"] })
      .map((edge) => edge.ancestorFqName.split("::").at(-1) ?? edge.ancestorFqName),
  );
  if (traits.size === 0) return undefined;
  const nameIsGloballyUnique =
    lookupRustSymbolsByShortName(ctx, typeName).filter(
      (def) =>
        (def.symbolKind === "class" || def.symbolKind === "enum") &&
        (def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`)),
    ).length === 1;
  const suffix = `#${member}`;
  const candidates = lookupRustSymbolsByShortName(ctx, member).filter((def) => {
    if (!def.symbolId.endsWith(suffix)) return false;
    const traitId = def.symbolId.slice(0, -suffix.length);
    const traitName = traitId.split("::").at(-1);
    if (traitName === undefined || !traits.has(traitName)) return false;
    const isTrait = ctx.symbolTable
      .lookup(traitId)
      .some((trait) => trait.relPath === def.relPath && trait.symbolKind === "interface");
    return isTrait && (nameIsGloballyUnique || rustCrateRootOf(def.relPath, ctx) === root);
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Whether a typed member miss on `owner` is PROVEN, so the call may drop
 * instead of reaching the prior read (bd tea-rags-mcp-s3i8m.5). The chain
 * typing is additive: a miss proves something only when the walk saw every
 * place the member could live. It did not when
 *   - the owner is placed on a file that only reopens it with an `impl` block
 *     (`impl Ext for Engine`, `impl Trait for Ref<'_, T>`), not its declaration;
 *   - another file's `impl` of the same type declares the member — Rust
 *     inherent impls may live in any module of the crate;
 *   - the owner implements `Deref` and the fold cannot follow it to a placed
 *     target (`type Target = EntryStorage<EK, ER>` on generics it dropped, a
 *     type-alias target).
 * A std type the fold carries unplaced keeps its miss verdict: its members
 * are std unless the project implements them on it, which the walk searched.
 */
export function rustTypedMissIsProven(owner: NominalTypeRef, member: string, ctx: CallContext): boolean {
  let current = owner;
  for (let hop = 0; hop < 3; hop++) {
    const boundary = current.name.indexOf(".rs::");
    if (boundary < 0) {
      const pointee = rustStdSmartPointerTarget(current, member);
      if (pointee?.form !== "instance") return true;
      current = pointee;
      continue;
    }
    const relPath = current.name.slice(0, boundary + 3);
    const typeId = current.name.slice(boundary + 5);
    const ownerDeclared = ctx.typeDeclarations?.[relPath]?.some((fact) => fact.typeId === typeId && !fact.reopens);
    if (ownerDeclared !== true) return false;
    if (ctx.symbolTable.lookup(`${typeId}#${member}`).length > 0) return false;
    if (ctx.symbolTable.lookup(`${typeId}.${member}`).length > 0) return false;
    if (ctx.symbolTable.lookup(`${typeId}#deref`).length === 0) return true;
    const derefTarget = rustDerefTarget(current, ctx);
    if (derefTarget === undefined) return rustDerefsToForeignMissing(current, relPath, typeId, member, ctx);
    if (derefTarget.name === current.name) return false;
    current = derefTarget;
  }
  return false;
}

/**
 * A `Deref` the fold could not place still proves the miss when its declared
 * target names no project type at all (`fn deref(&self) -> &str`, `-> &AttrValue`
 * from an external crate) and the project implements no such member on that
 * name. A generic parameter, a `Self::Target` spelling or a project type the
 * fold failed to place proves nothing.
 */
function rustDerefsToForeignMissing(
  owner: NominalTypeRef,
  relPath: string,
  typeId: string,
  member: string,
  ctx: CallContext,
): boolean {
  const deref = rustExactMember(owner, "deref", ctx);
  if (deref === undefined) return false;
  const derefReturn = ctx.structuredReturnTypes?.[`${deref.relPath}::${deref.symbolId}`];
  if (derefReturn?.form !== "instance" || derefReturn.name === "Self" || derefReturn.name.startsWith("Self::")) {
    return false;
  }
  const head = derefReturn.name.split("::").at(-1) ?? derefReturn.name;
  const generic = ctx.typeDeclarations?.[relPath]?.some(
    (fact) => fact.typeId === typeId && fact.genericParameters?.includes(head) === true,
  );
  if (generic === true) return false;
  const named = lookupRustSymbolsByShortName(ctx, head).filter(
    (def) => def.symbolId === head || def.symbolId.endsWith(`::${head}`),
  );
  if (named.length > 0 || rustProjectTypeShortNames(ctx).has(head)) return false;
  return !lookupRustSymbolsByShortName(ctx, member).some(
    (def) => isRustTypeMember(def.symbolId, head, "#", member) || isRustTypeMember(def.symbolId, head, ".", member),
  );
}

const PROJECT_TYPE_SHORT_NAMES = new RunScopedMemo<object, { files: number; names: ReadonlySet<string> }>();

/**
 * Every type short name the project declares — type aliases included, which
 * the symbol table may not chunk (`pub type BatchRouter<N, C> = Router<…>`).
 * Memoised per resolve run and rebuilt when the map's file count moves, since
 * the run state fills that map in place while it absorbs files.
 */
function rustProjectTypeShortNames(ctx: CallContext): ReadonlySet<string> {
  const declarations = ctx.typeDeclarations;
  if (declarations === undefined) return new Set();
  const files = Object.keys(declarations).length;
  const cached = PROJECT_TYPE_SHORT_NAMES.get(ctx.runScope, declarations);
  if (cached?.files === files) return cached.names;
  const names = new Set(
    Object.values(declarations).flatMap((facts) => facts.map((fact) => fact.typeId.split("::").at(-1) ?? "")),
  );
  PROJECT_TYPE_SHORT_NAMES.set(ctx.runScope, declarations, { files, names });
  return names;
}

function resolveRustNominalMemberOn(
  owner: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
) {
  if (owner.name.includes(".rs::")) {
    const hit = rustExactMember(owner, member, ctx);
    return hit === undefined ? null : { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  const typeName = owner.name;
  const candidates = lookupRustSymbolsByShortName(ctx, member);
  for (const separator of ["#", "."] as const) {
    const own = candidates.filter((def) => isRustTypeMember(def.symbolId, typeName, separator, member));
    const hit = pickSameFileThenSingle(own, ctx.callerFile, mode);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}

function isRustTypeMember(
  symbolId: SymbolDefinition["symbolId"],
  typeName: string,
  separator: "#" | ".",
  member: string,
): boolean {
  const own = `${typeName}${separator}${member}`;
  return symbolId === own || symbolId.endsWith(`::${own}`);
}
