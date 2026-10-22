import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { MemberReturnTypeResolver, type NominalTypeRef } from "../../kernel/index.js";
import {
  rustNameBoundByExternalImport,
  rustStdSmartPointerTarget,
  rustStdTypeRef,
  rustStdUnwrapType,
} from "./std-type-hops.js";
import { lookupRustSymbolsByShortName } from "./strategies/shared.js";

/** File-qualified nominal identity is kept inside the existing TypeRef channel, never a bare global namesake. */
export function resolveRustNominalType(nominalType: TypeRef, ctx: CallContext): NominalTypeRef | undefined {
  if (nominalType.form !== "instance" && nominalType.form !== "class") return undefined;
  const { name } = nominalType;
  if (/^(?:::)?(?:std|core|alloc)::/.test(name)) return undefined;
  if (!name.includes(".rs::") && rustNameBoundByExternalImport(name, ctx)) {
    // Only an EXTERNAL binding vetoes placement now. An import-bound project
    // type (`use script_bindings::Str2`) reaches the candidate lookup below,
    // where the sole-match and lexical-scope gates keep it honest — the old
    // blanket veto dropped every import-bound type from the chain fold no
    // matter where its definition lived.
    return undefined;
  }
  const shortName = name.split("::").at(-1);
  if (shortName === undefined) return undefined;
  const candidates = lookupRustSymbolsByShortName(ctx, shortName)
    .filter((def) => def.symbolKind === undefined || def.symbolKind === "class" || def.symbolKind === "enum")
    .filter((def) => def.symbolId === shortName || def.symbolId.endsWith(`::${shortName}`));
  let hit: SymbolDefinition | undefined;
  if (name.includes(".rs::")) {
    const boundary = name.indexOf(".rs::") + 3;
    const exact = candidates.filter(
      (def) => def.relPath === name.slice(0, boundary) && def.symbolId === name.slice(boundary + 2),
    );
    if (exact.length === 1) hit = exact[0];
  } else {
    // Lexical module scopes, innermost first. No suffix-based same-file tie-break.
    for (let depth = ctx.callerScope.length; depth >= 0 && hit === undefined; depth--) {
      const fq = [...ctx.callerScope.slice(0, depth), name].join("::");
      const local = candidates.filter((def) => def.relPath === ctx.callerFile && def.symbolId === fq);
      if (local.length === 1) hit = local[0];
      else if (local.length > 1) return undefined;
    }
    if (hit === undefined && candidates.length === 1 && candidates[0].symbolId === name) hit = candidates[0];
  }
  if (hit === undefined) return undefined;
  const typeArguments = nominalType.args?.map((arg) => resolveRustNominalType(arg, ctx));
  if (typeArguments?.some((arg) => arg === undefined)) return undefined;
  return {
    ...nominalType,
    name: `${hit.relPath}::${hit.symbolId}`,
    ...(typeArguments === undefined ? {} : { args: typeArguments as TypeRef[] }),
  };
}

/** Resolve a member ONLY under the fully identified owner; the old lookup keeps its own fallback outside this seam. */
export function rustExactMember(owner: NominalTypeRef, member: string, ctx: CallContext): SymbolDefinition | undefined {
  const boundary = owner.name.indexOf(".rs::");
  if (boundary < 0) return undefined;
  const relPath = owner.name.slice(0, boundary + 3);
  const fq = owner.name.slice(boundary + 5);
  const separator = owner.form === "class" ? "." : "#";
  const matches = ctx.symbolTable.lookup(`${fq}${separator}${member}`).filter((def) => def.relPath === relPath);
  return matches.length === 1 ? matches[0] : undefined;
}

const RUST_MEMBER_RETURN_TYPES = new MemberReturnTypeResolver({
  declaredReturnType: (owner, member, ctx) => {
    const target = rustExactMember(owner, member, ctx);
    if (target === undefined) return null;
    const declared = ctx.structuredReturnTypes?.[`${target.relPath}::${target.symbolId}`];
    if (declared === undefined) return null;
    const ownerName = owner.name.slice(owner.name.indexOf(".rs::") + 5);
    const declaration = ctx.typeDeclarations?.[target.relPath]?.find(
      (fact) => fact.typeId === ownerName && !fact.reopens,
    );
    const substitute = (recv: TypeRef): TypeRef | undefined => {
      if (recv.form !== "instance" && recv.form !== "class") return undefined;
      // `Self` and `Self::Target`-style associated paths answer the OWNER;
      // rustDerefTarget turns the degenerate owner answer into its single
      // generic argument, which is what `type Target = T` means for a
      // one-parameter smart pointer (`Root<T>`'s `-> &Self::Target`).
      if (recv.name === "Self" || recv.name.startsWith("Self::")) return { ...owner, form: "instance" };
      const parameter = declaration?.genericParameters?.indexOf(recv.name) ?? -1;
      if (parameter >= 0) return owner.args?.[parameter];
      // An argument nothing substitutes (an owner generic the receiver never
      // fixed: `-> &PeerStorage<EK, ER>` on a bare `Peer`) drops the argument
      // list and keeps the head typed — a member needing the argument then
      // declines on its own (bd tea-rags-mcp-2g2og.24).
      const substituted = recv.args?.map(substitute);
      const typeArguments = substituted?.every((arg) => arg !== undefined) ? substituted : undefined;
      const declaringCtx = { ...ctx, callerFile: target.relPath, callerScope: target.scope.slice(0, -1) };
      const head = resolveRustNominalType({ form: recv.form, name: recv.name }, declaringCtx);
      if (head === undefined) return rustStdTypeRef(recv.name, substituted, declaringCtx);
      const placed =
        typeArguments === undefined || typeArguments.length === 0 ? head : { ...head, args: typeArguments };
      // Cross-file, only a type the DECLARING file declares in its own lexical
      // scope is safe: the callee's import environment was never loaded, so a
      // name it bound through `use` must decline rather than land on a caller
      // -file namesake (`use external::Product` in lib.rs naming main.rs's
      // Product fabricated an edge before this constraint).
      if (target.relPath !== ctx.callerFile && !placed.name.startsWith(`${target.relPath}::`)) {
        return undefined;
      }
      return placed;
    };
    return substitute(declared) ?? null;
  },
  ancestorsOf: () => [],
  ancestorReturnType: () => null,
});

export function rustDeclaredMemberReturnType(
  nominalType: TypeRef,
  member: string,
  ctx: CallContext,
): TypeRef | undefined {
  // std hops first (bd tea-rags-mcp-2g2og.24): `Option`/`Result` unwrap through
  // `unwrap`/`expect`, a std smart pointer hands a member it does not answer to
  // its target. A placed project type never matches either.
  const unwrapped = rustStdUnwrapType(nominalType, member);
  if (unwrapped !== undefined) return unwrapped;
  const pointee = rustStdSmartPointerTarget(nominalType, member);
  if (pointee !== undefined) return rustDeclaredMemberReturnType(pointee, member, ctx);
  const owner = resolveRustNominalType(nominalType, ctx);
  if (owner === undefined) return undefined;
  // Rust method resolution auto-derefs: a member the owner misses is retried
  // on its `Deref::deref` declared return (a project smart pointer whose
  // `fn deref(&self) -> &T` was walked). Only true misses deref — a member the
  // owner declares is answered by the precedence walk above, byte-identically.
  let current: NominalTypeRef | undefined = owner;
  for (let hop = 0; current !== undefined && hop < 3; hop++) {
    const found = RUST_MEMBER_RETURN_TYPES.returnTypeOf(current, member, ctx);
    if (found !== null) return found ?? undefined;
    if (member === "deref") return undefined;
    const next = rustDerefTarget(current, ctx);
    if (next === undefined || next.name === current.name) return undefined;
    current = next;
  }
  return undefined;
}

/**
 * The placed `Deref` target of a project smart pointer — the `deref` method's
 * declared return, generic parameters substituted with the owner's own
 * (`Dom<Window>` derefs to the placed `Window`). The owner is placed first when
 * the typing port handed a raw binding annotation, so `Dom` resolves to its
 * declaring file before the `deref` return is read. Answers only a project
 * target: std smart pointers' `deref` lives outside the indexed source, so
 * `Rc<T>` / `Box<T>` receivers decline here exactly as before.
 */
export function rustDerefTarget(owner: NominalTypeRef, ctx: CallContext): NominalTypeRef | undefined {
  const placed = owner.name.includes(".rs::")
    ? owner
    : (resolveRustNominalType({ ...owner, form: owner.form === "class" ? "class" : "instance" }, ctx) ?? undefined);
  if (!placed?.name.includes(".rs::")) return undefined;
  const declared = RUST_MEMBER_RETURN_TYPES.returnTypeOf(placed, "deref", ctx);
  if (declared === null) return undefined;
  if (declared.form !== "instance" && declared.form !== "class") return undefined;
  if (declared.name === placed.name) {
    // The substitution answered the owner itself (`-> &Self::Target`): the
    // deref target is the pointer's single generic argument.
    const argument = placed.args?.[0];
    if (argument === undefined || placed.args?.length !== 1) return undefined;
    if (argument.form !== "instance" && argument.form !== "class") return undefined;
    const argumentPlaced = argument.name.includes(".rs::")
      ? argument
      : (resolveRustNominalType(argument, ctx) ?? undefined);
    if (!argumentPlaced?.name.includes(".rs::")) return undefined;
    return argumentPlaced;
  }
  const target = declared.name.includes(".rs::") ? declared : resolveRustNominalType(declared, ctx);
  if (!target?.name.includes(".rs::")) return undefined;
  return target;
}
