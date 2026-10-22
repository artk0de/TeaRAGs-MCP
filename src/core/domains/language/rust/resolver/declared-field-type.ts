import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { resolveRustNominalType } from "./declared-return-type.js";
import { rustCallerCrateUniqueType } from "./rust-crate-scope.js";
import { rustDeclaredTypeIsForeign, rustStdTypeRef } from "./std-type-hops.js";

/** The placed owner, its single struct declaration and the declared head of its field `member`. */
function rustPlacedField(recv: TypeRef, member: string, ctx: CallContext) {
  if (recv.form !== "instance" || !recv.name.includes(".rs::")) return undefined;
  const owner = resolveRustNominalType(recv, ctx);
  if (owner === undefined) return undefined;
  const boundary = owner.name.indexOf(".rs::") + 3;
  const ownerFile = owner.name.slice(0, boundary);
  const ownerId = owner.name.slice(boundary + 2);
  const declarations = ctx.typeDeclarations?.[ownerFile]?.filter(
    (fact) => fact.typeId === ownerId && fact.symbolKind === "class" && !fact.reopens,
  );
  if (declarations?.length !== 1) return undefined;
  const field = identifierEntry(identifierEntry(ctx.classFieldTypesByClassKey, owner.name), member);
  if (field === undefined) return undefined;
  return { owner, ownerFile, ownerId, declaration: declarations[0], field };
}

/**
 * Whether the placed owner's field `member` is declared with a provably
 * foreign type (`Arc<Url>`, `HashMap<K, V>`, `std::fs::OpenOptions`), so no
 * project member can answer a call on it (bd tea-rags-mcp-s3i8m.5). A generic
 * parameter of the owner, or a project type the fold could not place, proves
 * nothing.
 */
export function rustDeclaredFieldIsForeign(recv: TypeRef, member: string, ctx: CallContext): boolean {
  const placed = rustPlacedField(recv, member, ctx);
  if (placed === undefined) return false;
  const { declaration, field } = placed;
  if (declaration.genericParameters?.includes(field) === true) return false;
  return rustDeclaredTypeIsForeign(field, identifierEntry(declaration.fieldTypeArguments, member), ctx);
}

/** Read only the placed owner's explicitly declared named field, never a short-name field map. */
export function rustDeclaredFieldType(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
  const placed = rustPlacedField(recv, member, ctx);
  if (placed === undefined) return undefined;
  const { owner, ownerFile, ownerId, declaration, field } = placed;
  const substitute = (name: string): TypeRef | undefined => {
    const parameter = declaration.genericParameters?.indexOf(name) ?? -1;
    if (parameter >= 0) {
      const argument = owner.args?.[parameter];
      return argument?.form === "instance" && argument.name.includes(".rs::") ? argument : undefined;
    }
    // The caller's imports cannot place another file's nominal spelling.
    if (ownerFile !== ctx.callerFile) return undefined;
    return resolveRustNominalType(
      { form: "instance", name },
      { ...ctx, callerScope: ownerId.split("::").slice(0, -1) },
    );
  };
  const genericFieldParameter = identifierEntry(declaration.genericFieldParameters, member);
  if (genericFieldParameter !== undefined) {
    return genericFieldParameter === field ? substitute(genericFieldParameter) : undefined;
  }
  const typeArguments = identifierEntry(declaration.fieldTypeArguments, member)?.map((name) =>
    name === null ? undefined : (substitute(name) ?? rustStdTypeRef(name, undefined, ctx)),
  );
  const nominalType = substitute(field);
  // A std field type (`Vec<Part>`, `Option<Product>`, `Arc<Core>`) carries no
  // file; it travels as its std spelling so the chain can deref / unwrap it or
  // end on it (bd tea-rags-mcp-2g2og.24).
  if (nominalType === undefined) return rustStdTypeRef(field, typeArguments, ctx);
  if (nominalType.form !== "instance") return undefined;
  // An argument the owner cannot place leaves the head typed and drops every
  // argument: a member that needs one (`item: U`) then declines on its own.
  if (typeArguments === undefined || typeArguments.some((arg) => arg === undefined)) return nominalType;
  return { ...nominalType, args: typeArguments as TypeRef[] };
}

/** Compound chains may seed `self` only inside a proven instance method on an exact lexical owner. */
export function rustLexicalSelfType(ctx: CallContext): TypeRef | undefined {
  const symbolId = ctx.callerSymbolId;
  if (symbolId === undefined || !symbolId.includes("#") || !ctx.callerFile.endsWith(".rs")) return undefined;
  const hash = symbolId.lastIndexOf("#");
  // A nested free function retains its ancestor's `#` (`Holder#run.nested`),
  // but only a final instance-method segment proves a usable self receiver.
  const member = symbolId.slice(hash + 1);
  if (member.includes(".") || member.includes(":")) return undefined;
  const ownerId = symbolId.slice(0, hash);
  const fileDeclarations = ctx.typeDeclarations?.[ctx.callerFile];
  const declarations = fileDeclarations?.filter(
    (fact) => fact.typeId === ownerId && fact.symbolKind === "class" && !fact.reopens,
  );
  if (!ctx.symbolTable.lookup(symbolId).some((def) => def.relPath === ctx.callerFile && def.symbolId === symbolId)) {
    return undefined;
  }
  if (declarations?.length !== 1) {
    const declaredHere = fileDeclarations?.some((fact) => fact.typeId === ownerId && !fact.reopens) !== false;
    return declaredHere ? undefined : rustCrateSelfType(ownerId, ctx);
  }
  const ownerScope = ownerId.split("::");
  if (!ownerScope.every((name, index) => ctx.callerScope[index] === name)) return undefined;
  return resolveRustNominalType({ form: "instance", name: `${ctx.callerFile}::${ownerId}` }, ctx);
}

/**
 * `self` in an impl whose type the caller's file does not declare (bd
 * tea-rags-mcp-s3i8m Task 2): Rust keeps inherent impls inside the defining
 * crate, so a type name unique in the caller's crate IS the impl's type. The
 * impl must sit directly on that name (`callerScope.at(-1) === T`); any other
 * namesake in the crate, or a bare-path `use` rebinding it, declines.
 */
function rustCrateSelfType(ownerId: string, ctx: CallContext): TypeRef | undefined {
  const typeName = ownerId.split("::").at(-1);
  if (typeName === undefined || ctx.callerScope.at(-1) !== typeName) return undefined;
  const owner = rustCallerCrateUniqueType(typeName, ctx);
  if (owner === undefined) return undefined;
  return resolveRustNominalType({ form: "instance", name: `${owner.relPath}::${owner.symbolId}` }, ctx);
}
