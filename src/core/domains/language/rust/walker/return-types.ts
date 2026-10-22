import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { DefaultSymbolIdComposer } from "../../kernel/index.js";
import { rustNameOf } from "./name-of.js";

/**
 * The nominal Rust type as declared; references preserve the referent and generic arguments keep their positions.
 * A tuple type keeps its elements in order (bd tea-rags-mcp-s3i8m, Task 1a), each one required.
 */
export function rustDeclaredTypeRef(node: AstNode | null): TypeRef | undefined {
  if (node === null) return undefined;
  if (node.type === "reference_type") return rustDeclaredTypeRef(node.childForFieldName("type"));
  if (node.type === "tuple_type") {
    const elements = node.namedChildren.map(rustDeclaredTypeRef);
    if (elements.length === 0 || elements.some((element) => element === undefined)) return undefined;
    return { form: "tuple", elements: elements as TypeRef[] };
  }
  if (["identifier", "type_identifier", "scoped_type_identifier", "scoped_identifier"].includes(node.type)) {
    return { form: "instance", name: node.text };
  }
  if (node.type !== "generic_type") return undefined;
  const genericType = rustDeclaredTypeRef(node.childForFieldName("type"));
  const argumentsNode = node.childForFieldName("type_arguments");
  if (genericType?.form !== "instance" || argumentsNode === null) return undefined;
  const typeArguments = argumentsNode.namedChildren
    .filter((argumentNode) => argumentNode.type !== "lifetime")
    .map(rustDeclaredTypeRef);
  if (typeArguments.some((arg) => arg === undefined)) return undefined;
  return { ...genericType, args: typeArguments as TypeRef[] };
}

export function rustGenericParameters(node: AstNode): string[] {
  return (node.childForFieldName("type_parameters")?.namedChildren ?? [])
    .filter((parameterNode) => parameterNode.type === "type_parameter")
    .map((parameterNode) => parameterNode.childForFieldName("name")?.text)
    .filter((name): name is string => name !== undefined);
}

/** Exact callable ids, qualified by file before the run-global record merge. No owner-less return channel. */
export function collectRustReturnTypes(root: AstNode, relPath: string): Record<string, TypeRef> {
  const returnTypes: Record<string, TypeRef> = createIdentifierRecord();
  const ambiguous = new Set<string>();
  const composer = new DefaultSymbolIdComposer();
  const declarations = new Map<string, readonly string[]>();
  const collectOwners = (node: AstNode, scope: readonly string[]): void => {
    const named = rustNameOf(node);
    if (named !== null && (node.type === "struct_item" || node.type === "enum_item")) {
      declarations.set([...scope, named.name].join("::"), rustGenericParameters(node));
    }
    if (node.type === "function_item") return;
    const childScope = named === null ? scope : [...scope, named.name];
    for (const child of node.children) collectOwners(child, childScope);
  };
  collectOwners(root, []);
  const visit = (
    node: AstNode,
    scope: readonly string[],
    inheritedUnsafeOwner: boolean,
    inheritedAssociatedTypes: ReadonlyMap<string, TypeRef>,
  ): void => {
    let unsafeOwner = inheritedUnsafeOwner;
    let associatedTypes = inheritedAssociatedTypes;
    const named = rustNameOf(node);
    if (node.type === "impl_item" && named !== null) {
      const parameters = declarations.get([...scope, named.name].join("::"));
      const owner = rustDeclaredTypeRef(node.childForFieldName("type"));
      const ownerTypeArguments = owner?.form === "instance" ? (owner.args ?? []) : [];
      const implParameters = rustGenericParameters(node);
      associatedTypes = rustConcreteAssociatedTypes(node, implParameters);
      if (ownerTypeArguments.length > 0 || implParameters.length > 0) {
        unsafeOwner ||=
          parameters?.length !== ownerTypeArguments.length ||
          implParameters.length !== parameters.length ||
          parameters.some((parameter, index) => {
            const argument = ownerTypeArguments[index];
            return (
              implParameters[index] !== parameter ||
              argument?.form !== "instance" ||
              argument.name !== parameter ||
              argument.args !== undefined
            );
          });
      }
    }
    if (node.type === "function_item" || node.type === "function_signature_item") {
      if (
        node.children.some(
          (modifiers) =>
            modifiers.type === "function_modifiers" && modifiers.children.some((modifier) => modifier.type === "async"),
        )
      ) {
        return;
      }
      const spelledType = rustDeclaredTypeRef(node.childForFieldName("return_type"));
      const associatedName =
        spelledType?.form === "instance" && spelledType.args === undefined && spelledType.name.startsWith("Self::")
          ? spelledType.name.slice("Self::".length)
          : undefined;
      const declaredType =
        (associatedName === undefined ? undefined : associatedTypes.get(associatedName)) ?? spelledType;
      const generics = new Set(rustGenericParameters(node));
      const unknown = (recv: TypeRef): boolean =>
        recv.form === "tuple"
          ? recv.elements.some(unknown)
          : (recv.form === "instance" || recv.form === "class") &&
            (generics.has(recv.name) || (recv.args?.some(unknown) ?? false));
      if (!unsafeOwner && named !== null && declaredType !== undefined && !unknown(declaredType)) {
        const id = composer.compose(scope.join("::"), named.name, {
          scopeSeparator: "::",
          methodKind: named.methodKind,
        });
        const key = `${relPath}::${id}`;
        // A namesake declared again (an inherent `fn` and a trait impl's, servo's
        // `Promise::new_in_realm`) is ambiguous only when the two returns differ:
        // agreeing declarations type the call whichever one Rust picks (bd tea-rags-mcp-s3i8m).
        if (Object.hasOwn(returnTypes, key) && JSON.stringify(returnTypes[key]) === JSON.stringify(declaredType)) {
          return;
        }
        if (Object.hasOwn(returnTypes, key)) {
          delete returnTypes[key];
          ambiguous.add(key);
        } else if (!ambiguous.has(key)) returnTypes[key] = declaredType;
      }
      return;
    }
    const childScope = named === null ? scope : [...scope, named.name];
    for (const child of node.children) visit(child, childScope, unsafeOwner, associatedTypes);
  };
  visit(root, [], false, new Map());
  return returnTypes;
}

/**
 * An impl's `type Name = Concrete;` items (bd tea-rags-mcp-s3i8m): a method
 * declared `-> &Self::Target` in `impl Deref for RootedPromise { type Target =
 * Promise; … }` returns `Promise`. An associated type naming one of the impl's
 * generic parameters (`type Target = T`) stays `Self::Target`, which the
 * resolver reads as the owner's single argument.
 */
function rustConcreteAssociatedTypes(node: AstNode, implParameters: readonly string[]): Map<string, TypeRef> {
  const associated = new Map<string, TypeRef>();
  const mentionsParameter = (recv: TypeRef): boolean =>
    recv.form === "tuple"
      ? recv.elements.some(mentionsParameter)
      : (recv.form === "instance" || recv.form === "class") &&
        (implParameters.includes(recv.name) ||
          recv.name.startsWith("Self::") ||
          (recv.args?.some(mentionsParameter) ?? false));
  for (const item of node.childForFieldName("body")?.namedChildren ?? []) {
    if (item.type !== "type_item") continue;
    const name = item.childForFieldName("name")?.text;
    const declared = rustDeclaredTypeRef(item.childForFieldName("type"));
    if (name !== undefined && declared !== undefined && !mentionsParameter(declared)) associated.set(name, declared);
  }
  return associated;
}
