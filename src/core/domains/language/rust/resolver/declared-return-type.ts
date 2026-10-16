import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { MemberReturnTypeResolver, type NominalTypeRef } from "../../kernel/index.js";
import { lookupRustSymbolsByShortName, rustImportBindings } from "./strategies/shared.js";

/** File-qualified nominal identity is kept inside the existing TypeRef channel, never a bare global namesake. */
export function resolveRustNominalType(nominalType: TypeRef, ctx: CallContext): NominalTypeRef | undefined {
  if (nominalType.form !== "instance" && nominalType.form !== "class") return undefined;
  const { name } = nominalType;
  if (/^(?:::)?(?:std|core|alloc)::/.test(name)) return undefined;
  if (
    !name.includes(".rs::") &&
    ctx.imports.some((imp) => rustImportBindings(imp.importText)?.some((binding) => binding.localName === name))
  ) {
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
      if (recv.name === "Self") return { ...owner, form: "instance" };
      const parameter = declaration?.genericParameters?.indexOf(recv.name) ?? -1;
      if (parameter >= 0) return owner.args?.[parameter];
      // Only the caller's imports are in scope. Another file's nominal spelling
      // cannot be resolved safely without that file's own import environment.
      if (target.relPath !== ctx.callerFile) return undefined;
      const typeArguments = recv.args?.map(substitute);
      if (typeArguments?.some((arg) => arg === undefined)) return undefined;
      return resolveRustNominalType(
        { ...recv, ...(typeArguments === undefined ? {} : { args: typeArguments as TypeRef[] }) },
        {
          ...ctx,
          callerFile: target.relPath,
          callerScope: target.scope.slice(0, -1),
        },
      );
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
  const owner = resolveRustNominalType(nominalType, ctx);
  return owner === undefined ? undefined : (RUST_MEMBER_RETURN_TYPES.returnTypeOf(owner, member, ctx) ?? undefined);
}
