import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import { isSameAstNode, type AstNode } from "../../../../contracts/types/ast.js";
import type { CallResultBinding } from "../../../../contracts/types/codegraph.js";
import { rustGenericParameters } from "./return-types.js";

/** Inventory the file once, then collect only proven function-body bare-call result locals. */
export function collectRustCallResultBindings(root: AstNode): ReadonlyMap<string, Record<string, CallResultBinding[]>> {
  const functionNodes: AstNode[] = [];
  const unsafeCallees = new Set<string>();
  const scan = (node: AstNode): void => {
    if (node.type === "function_item") {
      functionNodes.push(node);
      // Lifetime-only generics stay safe callees: the declared return names no
      // call-site type argument, and lifetimes are dropped by the TypeRef
      // parse anyway (`enter_auto_realm<'cx> -> Root<'cx, Realm>`). A TYPE
      // parameter can monomorphize the return (`fn id<T>(t: T) -> T`), so
      // those callees remain unsafe.
      if (rustGenericParameters(node).length > 0) {
        const name = node.childForFieldName("name");
        if (name !== null) unsafeCallees.add(name.text);
      }
    }
    if (node.type === "const_item" || node.type === "static_item" || node.type === "macro_definition") {
      const name = node.childForFieldName("name");
      if (name !== null) unsafeCallees.add(name.text);
    }
    for (const child of node.children) scan(child);
  };
  scan(root);
  const byRange = new Map<string, Record<string, CallResultBinding[]>>();
  const duplicateRanges = new Set<string>();
  for (const fn of functionNodes) {
    const key = `${fn.startPosition.row + 1}:${fn.endPosition.row + 1}`;
    if (byRange.has(key)) duplicateRanges.add(key);
    else byRange.set(key, rustFunctionCallResultBindings(fn, unsafeCallees));
  }
  for (const key of duplicateRanges) byRange.delete(key);
  return byRange;
}

function rustFunctionCallResultBindings(
  fn: AstNode,
  unsafeCallees: ReadonlySet<string>,
): Record<string, CallResultBinding[]> {
  const bindings: Record<string, CallResultBinding[]> = createIdentifierRecord();
  const endLine = fn.endPosition.row + 1;
  // A local item inherits enclosing bindings; this slice proves no capture or nested callable scope.
  let { parent } = fn;
  while (parent !== null) {
    if (parent.type === "function_item" || parent.type === "closure_expression" || parent.type === "block") {
      return bindings;
    }
    ({ parent } = parent);
  }
  const body = fn.childForFieldName("body");
  if (body?.type !== "block") return bindings;
  const declarations = new Map<string, number>();
  const assigned = new Set<string>();
  const candidates = new Map<string, CallResultBinding>();
  let uncertain = false;
  const declare = (pattern: AstNode | null): void => {
    if (pattern?.type !== "identifier") {
      uncertain = true;
      return;
    }
    declarations.set(pattern.text, (declarations.get(pattern.text) ?? 0) + 1);
  };
  const params = fn.childForFieldName("parameters");
  for (const param of params?.children ?? []) {
    if (param.type === "parameter") declare(param.childForFieldName("pattern"));
  }
  const visit = (node: AstNode): void => {
    if (
      node.type === "ERROR" ||
      node.type === "closure_expression" ||
      node.type === "function_item" ||
      node.type === "let_condition" ||
      node.type === "for_expression" ||
      node.type === "match_expression" ||
      node.type === "const_item" ||
      node.type === "static_item" ||
      node.type === "macro_definition" ||
      node.type === "use_declaration" ||
      node.type === "macro_invocation"
    ) {
      uncertain = true;
      return;
    }
    if (node.type === "let_declaration") {
      const pattern = node.childForFieldName("pattern");
      declare(pattern);
      const value = node.childForFieldName("value");
      const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
      // A method init (`let wb = e.write_batch();`) records its dotted path
      // beside the bare free-function one — the resolver types the receiver
      // and reads the method's declared return (bd tea-rags-mcp-2g2og).
      if (
        isSameAstNode(node.parent, body) &&
        pattern?.type === "identifier" &&
        node.childForFieldName("type") === null &&
        (callee?.type === "identifier" || callee?.type === "field_expression")
      ) {
        candidates.set(pattern.text, {
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scopeEndLine: endLine,
          callee: callee.text,
        });
      }
    }
    if (node.type === "assignment_expression" || node.type === "compound_assignment_expr") {
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") assigned.add(left.text);
      else uncertain = true;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of body.children) visit(child);
  if (uncertain) return bindings;
  for (const [name, binding] of candidates) {
    if (
      declarations.get(name) === 1 &&
      !assigned.has(name) &&
      !declarations.has(binding.callee) &&
      !assigned.has(binding.callee) &&
      !unsafeCallees.has(binding.callee)
    ) {
      bindings[name] = [binding];
    }
  }
  return bindings;
}
