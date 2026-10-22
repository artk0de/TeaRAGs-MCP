import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { resolveRustNominalType } from "./declared-return-type.js";
import { rustStdTypeRef } from "./std-type-hops.js";

/** Read only the placed owner's explicitly declared named field, never a short-name field map. */
export function rustDeclaredFieldType(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
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
  const declaration = declarations[0];
  const field = identifierEntry(identifierEntry(ctx.classFieldTypesByClassKey, owner.name), member);
  if (field === undefined) return undefined;
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
  const declarations = ctx.typeDeclarations?.[ctx.callerFile]?.filter(
    (fact) => fact.typeId === ownerId && fact.symbolKind === "class" && !fact.reopens,
  );
  if (declarations?.length !== 1) return undefined;
  if (!ctx.symbolTable.lookup(symbolId).some((def) => def.relPath === ctx.callerFile && def.symbolId === symbolId)) {
    return undefined;
  }
  const ownerScope = ownerId.split("::");
  if (!ownerScope.every((name, index) => ctx.callerScope[index] === name)) return undefined;
  return resolveRustNominalType({ form: "instance", name: `${ctx.callerFile}::${ownerId}` }, ctx);
}
