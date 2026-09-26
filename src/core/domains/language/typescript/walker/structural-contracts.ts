/**
 * The two TypeScript facts structural conformance reads (bd
 * tea-rags-mcp-39xca.14): the file's structural contracts, and the positional
 * arity of each callable definition.
 *
 * A contract is an `interface` or a `type X = { … }` object type. Its members
 * are the REQUIRED callable ones — method signatures and properties typed as a
 * function, without `?`. Data properties, index and call signatures are left
 * out: the symbol table carries no field definitions to check them against, so
 * keeping them would make every data-bearing interface unsatisfiable.
 *
 * Arity is keyed by the line of the DECLARING node — the method, the function,
 * or the declarator / pair / field that binds an arrow or function expression —
 * which is the line `collectSymbols` starts that definition's chunk on. An
 * arrow nested in a body (a `.map` callback) binds no name and is never keyed.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  AritySignature,
  StructuralContractDecl,
  StructuralContractMember,
  SymbolDefinitionKind,
} from "../../../../contracts/types/codegraph.js";
import { constObjectNamespaceName } from "../../../../infra/symbolid/index.js";
import { symbolIdNames } from "../../kernel/symbol-id.js";

/** A rest parameter accepts any number of arguments, so no implementation requires too many. */
const UNBOUNDED_PARAMS = Number.MAX_SAFE_INTEGER;

/** Nodes that declare a callable with their own `parameters`. */
const CALLABLE_DECLARATIONS: ReadonlySet<string> = new Set([
  "method_definition",
  "function_declaration",
  "generator_function_declaration",
  "abstract_method_signature",
]);

/** Nodes that bind a name to their `value` — an arrow or function expression there is a named callable. */
const VALUE_BINDERS: ReadonlySet<string> = new Set(["variable_declarator", "pair", "public_field_definition"]);

const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function"]);

/**
 * Every structural contract the file declares, in source order of first
 * declaration. A re-opened interface (declaration merging) contributes its
 * members to the one declaration of its name.
 */
export function collectTypescriptStructuralContracts(root: AstNode): StructuralContractDecl[] {
  const byName = new Map<string, Map<string, number>>();
  visit(root, (node) => {
    const body = contractBody(node);
    if (body === null) return;
    const name = node.childForFieldName("name")?.text;
    if (name === undefined || name.length === 0) return;
    let members = byName.get(name);
    if (members === undefined) byName.set(name, (members = new Map<string, number>()));
    for (const member of body.namedChildren) {
      const required = requiredCallableMember(member);
      if (required !== null && !members.has(required.name)) members.set(required.name, required.params);
    }
  });
  const out: StructuralContractDecl[] = [];
  for (const [name, members] of byName) {
    if (members.size === 0) continue;
    out.push({ name, members: [...members].map(([memberName, params]) => ({ name: memberName, params })) });
  }
  return out;
}

/** `startLine → arity` of every named callable definition in the file. */
export function collectTypescriptCallableArities(root: AstNode): Map<number, AritySignature> {
  const out = new Map<number, AritySignature>();
  visit(root, (node) => {
    const params = callableParameters(node);
    if (params === undefined) return;
    const line = node.startPosition.row + 1;
    // Pre-order: an outer declaration on a line wins over anything nested on it.
    if (!out.has(line)) out.set(line, aritySignature(params));
  });
  return out;
}

/**
 * `startLine → name` of every declarator initialized by an object literal the
 * walker names — the const-object namespace, `const X = { m() {} }`, at any
 * depth and through `as` / `satisfies` (bd tea-rags-mcp-39xca.19). Its chunk is
 * recorded as `symbolKind: "module"`: the literal is itself the value that can
 * satisfy a contract, so structural conformance counts its `.` members. Keyed
 * like arity, by the declarator's line; the name disambiguates the chunk that
 * starts on it. Shared with the JavaScript walker, which names the same shape
 * through the same gate.
 */
export function collectObjectLiteralDeclarators(root: AstNode): Map<number, string> {
  const out = new Map<number, string>();
  visit(root, (node) => {
    const name = constObjectNamespaceName(node);
    if (name === null) return;
    const line = node.startPosition.row + 1;
    if (!out.has(line)) out.set(line, name);
  });
  return out;
}

/**
 * The `symbolKind` a chunk takes from {@link collectObjectLiteralDeclarators}:
 * `module` when an object-literal declarator starts on the chunk's line under
 * the chunk's own name, else undefined (the walker records no kind).
 */
export function objectLiteralDeclaratorKind(
  declarators: ReadonlyMap<number, string>,
  chunk: { readonly symbolId: string; readonly startLine: number },
): SymbolDefinitionKind | undefined {
  const name = declarators.get(chunk.startLine);
  return name !== undefined && symbolIdNames(chunk.symbolId, name) ? "module" : undefined;
}

/** The member list of an interface or an object-type alias, else `null`. */
function contractBody(node: AstNode): AstNode | null {
  if (node.type === "interface_declaration") return node.childForFieldName("body");
  if (node.type === "type_alias_declaration") {
    const value = node.childForFieldName("value");
    return value?.type === "object_type" ? value : null;
  }
  return null;
}

function requiredCallableMember(member: AstNode): StructuralContractMember | null {
  if (member.type !== "method_signature" && member.type !== "property_signature") return null;
  if (member.children.some((child) => child.type === "?")) return null;
  const name = member.childForFieldName("name")?.text;
  if (name === undefined || name.length === 0) return null;
  const parameters =
    member.type === "method_signature"
      ? member.childForFieldName("parameters")
      : functionTypeParameters(member.childForFieldName("type"));
  if (parameters === null) return null;
  const arity = aritySignature(parameters);
  return { name, params: arity.hasSplat ? UNBOUNDED_PARAMS : arity.maxPositional };
}

/** The parameters of a property's `: (…) => T` annotation; `null` for any other type. */
function functionTypeParameters(annotation: AstNode | null): AstNode | null {
  const type = annotation?.namedChildren.find((child) => child.type !== ":") ?? null;
  return type?.type === "function_type" ? type.childForFieldName("parameters") : null;
}

/**
 * The parameter list of a named callable declaration, `null` for a single bare
 * arrow parameter (`x => x`), `undefined` for a node that declares no callable.
 */
function callableParameters(node: AstNode): AstNode | null | undefined {
  if (CALLABLE_DECLARATIONS.has(node.type)) return node.childForFieldName("parameters");
  if (!VALUE_BINDERS.has(node.type)) return undefined;
  const value = node.childForFieldName("value");
  if (value === null || !FUNCTION_VALUES.has(value.type)) return undefined;
  return value.childForFieldName("parameters");
}

/**
 * Positional arity of a `formal_parameters` list. `this` is a type annotation,
 * not an argument; a defaulted parameter is optional; a rest parameter makes the
 * upper bound open. `null` = a single bare arrow parameter.
 */
function aritySignature(parameters: AstNode | null): AritySignature {
  if (parameters === null) return { minRequired: 1, maxPositional: 1, hasSplat: false };
  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  for (const param of parameters.namedChildren) {
    const pattern = param.childForFieldName("pattern");
    if (pattern?.type === "this") continue;
    if (pattern?.type === "rest_pattern") {
      hasSplat = true;
      continue;
    }
    if (param.type === "required_parameter") {
      maxPositional++;
      if (param.childForFieldName("value") === null) minRequired++;
    } else if (param.type === "optional_parameter") {
      maxPositional++;
    }
  }
  return { minRequired, maxPositional, hasSplat };
}

function visit(node: AstNode, fn: (node: AstNode) => void): void {
  fn(node);
  for (const child of node.namedChildren) visit(child, fn);
}
