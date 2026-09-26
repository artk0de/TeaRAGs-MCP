/**
 * Python structural contracts (bd tea-rags-mcp-39xca.14): a class whose bases
 * include `typing.Protocol` (PEP 544) is satisfied by any class carrying its
 * methods, subclass or not. The barrier matches these against the symbol
 * table's owners so a receiver typed by the Protocol reaches its structural
 * implementers through the CHA cone.
 *
 * The contract is named exactly as `collectPythonInheritanceEdges` names a
 * class source — qualified by its enclosing classes with `.` — because the
 * hierarchy keys both. Members are the class body's methods; `params` is the
 * positional count the def-signature pass already computed with `self` / `cls`
 * dropped, open-ended when the method takes `*args`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { StructuralContractDecl, StructuralContractMember } from "../../../../contracts/types/codegraph.js";
import type { PythonDefSignature } from "./passes/python-def-signatures.js";

/** A rest parameter accepts any number of arguments, so no implementation requires too many. */
const UNBOUNDED_PARAMS = Number.MAX_SAFE_INTEGER;

/** The base spellings that make a class a Protocol, generic arguments stripped. */
const PROTOCOL_BASES: ReadonlySet<string> = new Set(["Protocol", "typing.Protocol", "typing_extensions.Protocol"]);

/**
 * Every Protocol the file declares, in source order. `defSignatures` is the
 * walker's `def line → signature` index, so no def is re-read here.
 */
export function collectPythonStructuralContracts(
  root: AstNode,
  defSignatures: ReadonlyMap<number, PythonDefSignature>,
): StructuralContractDecl[] {
  const out: StructuralContractDecl[] = [];
  const walkScope = (node: AstNode, scope: readonly string[]): void => {
    if (node.type !== "class_definition") {
      for (const child of node.namedChildren) walkScope(child, scope);
      return;
    }
    const localName = node.childForFieldName("name")?.text;
    const body = node.childForFieldName("body");
    if (localName === undefined || body === null) return;
    const fq = [...scope, localName].join(".");
    if (isProtocolClass(node)) {
      const members = protocolMembers(body, defSignatures);
      if (members.length > 0) out.push({ name: fq, members });
    }
    for (const child of body.namedChildren) walkScope(child, [...scope, localName]);
  };
  walkScope(root, []);
  return out;
}

function isProtocolClass(classNode: AstNode): boolean {
  const supers = classNode.childForFieldName("superclasses");
  if (supers === null) return false;
  return supers.namedChildren.some((base) => {
    const named = base.type === "subscript" ? base.childForFieldName("value") : base;
    return named !== null && PROTOCOL_BASES.has(named.text);
  });
}

/** The methods declared directly in a Protocol's body, decorated or not. */
function protocolMembers(
  body: AstNode,
  defSignatures: ReadonlyMap<number, PythonDefSignature>,
): StructuralContractMember[] {
  const members: StructuralContractMember[] = [];
  for (const statement of body.namedChildren) {
    const def = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
    if (def?.type !== "function_definition") continue;
    const name = def.childForFieldName("name")?.text;
    if (name === undefined || members.some((member) => member.name === name)) continue;
    const arity = defSignatures.get(def.startPosition.row + 1)?.arity;
    const params = arity === undefined ? UNBOUNDED_PARAMS : arity.hasSplat ? UNBOUNDED_PARAMS : arity.maxPositional;
    members.push({ name, params });
  }
  return members;
}
