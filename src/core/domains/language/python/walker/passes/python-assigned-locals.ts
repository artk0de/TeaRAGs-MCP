/**
 * The names each `def` binds as LOCALS, typed or not (bd
 * tea-rags-mcp-m99j1.1.57).
 *
 * The typed channels say what a local IS — `localBindings` when the walker could
 * type the right-hand side, `callResultBindings` when it was a call. Neither
 * says that a name IS a local when the right-hand side is a subscript, an
 * attribute read or anything else nothing types (`client =
 * OAUTH_CLIENTS[platform]`, `loader = self.app.jinja_loader`). This pass records
 * that presence and nothing more.
 *
 * Python's scoping rule is what makes a name-only set exact: a name bound
 * anywhere in a function body is that body's local on EVERY line of it (reading
 * it before the binding is an `UnboundLocalError`, not a global read). So a
 * position would add nothing.
 *
 * Binding forms: assignment (chained and unpacking included), augmented and
 * annotated assignment (a bare `x: T` declares too), `for` and comprehension
 * `for` targets, `with … as`, `except … as`, a `case … as` capture and the
 * walrus. Attribute and subscript targets bind no name. A def's own parameters
 * are not recorded — they are bound by the caller, and whether a fan may
 * dispatch on one is the dispatch gate's question — and neither are names the
 * def declares `global` / `nonlocal`, which belong to another scope.
 *
 * A nested def also inherits its enclosing defs' locals (a closure read is the
 * outer def's local), minus the names it rebinds as its own parameters. A class
 * body is not a function scope: its assignments are class attributes, and a
 * method nested in it closes over the enclosing DEF, never the class.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";

interface PythonDefFrame {
  readonly line: number;
  readonly parent: PythonDefFrame | undefined;
  readonly names: Set<string>;
  readonly params: Set<string>;
  readonly declaredElsewhere: Set<string>;
}

/** Containers a binding target unpacks through; anything else (attribute, subscript) binds no name. */
const UNPACKING_TARGETS: ReadonlySet<string> = new Set([
  "pattern_list",
  "tuple_pattern",
  "list_pattern",
  "tuple",
  "list",
  "parenthesized_expression",
  "list_splat_pattern",
  "list_splat",
  "as_pattern_target",
]);

function addTargetNames(target: AstNode | null, into: Set<string>): void {
  if (target === null) return;
  if (target.type === "identifier") {
    into.add(target.text);
    return;
  }
  if (!UNPACKING_TARGETS.has(target.type)) return;
  for (const child of target.namedChildren) addTargetNames(child, into);
}

function paramNameNode(param: AstNode): AstNode | null {
  if (param.type === "identifier") return param;
  const name = param.childForFieldName("name");
  if (name !== null) return name;
  // `typed_parameter`, `*args`, `**kw`: the identifier is the first named child.
  const first = param.namedChildren[0];
  return first?.type === "identifier" ? first : null;
}

function collectParams(def: AstNode): Set<string> {
  const out = new Set<string>();
  for (const param of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const name = paramNameNode(param);
    if (name !== null) out.add(name.text);
  }
  return out;
}

/** The binding target(s) one node introduces into the CURRENT def, if it is a binding form. */
function recordBinding(node: AstNode, frame: PythonDefFrame): void {
  switch (node.type) {
    case "assignment":
    case "augmented_assignment":
    case "for_statement":
    case "for_in_clause":
      addTargetNames(node.childForFieldName("left"), frame.names);
      return;
    case "as_pattern":
      addTargetNames(node.childForFieldName("alias"), frame.names);
      return;
    case "named_expression":
      addTargetNames(node.childForFieldName("name"), frame.names);
      return;
    case "global_statement":
    case "nonlocal_statement":
      for (const child of node.namedChildren) frame.declaredElsewhere.add(child.text);
      break;
    default:
      break;
  }
}

function scan(node: AstNode, frame: PythonDefFrame | undefined, recording: boolean, frames: PythonDefFrame[]): void {
  if (node.type === "function_definition") {
    const own: PythonDefFrame = {
      line: node.startPosition.row + 1,
      parent: frame,
      names: new Set(),
      params: collectParams(node),
      declaredElsewhere: new Set(),
    };
    frames.push(own);
    const body = node.childForFieldName("body");
    if (body !== null) scan(body, own, true, frames);
    return;
  }
  // A lambda's own parameters and walrus targets are the lambda's; it cannot hold a def.
  if (node.type === "lambda") return;
  if (node.type === "class_definition") {
    const body = node.childForFieldName("body");
    if (body !== null) scan(body, frame, false, frames);
    return;
  }
  if (recording && frame !== undefined) recordBinding(node, frame);
  for (const child of node.namedChildren) scan(child, frame, recording, frames);
}

function ownLocals(frame: PythonDefFrame): Set<string> {
  const out = new Set<string>();
  for (const name of frame.names) {
    if (!frame.params.has(name) && !frame.declaredElsewhere.has(name)) out.add(name);
  }
  return out;
}

/**
 * `def` line (1-based, decorators unwrapped — the line a def chunk starts on) →
 * the sorted locals that def can see as its own or its enclosing defs'. A def
 * that binds nothing is absent.
 */
export function collectPythonAssignedLocals(root: AstNode): Map<number, string[]> {
  const frames: PythonDefFrame[] = [];
  scan(root, undefined, false, frames);
  const visible = new Map<PythonDefFrame, Set<string>>();
  // `frames` is in pre-order, so every parent is resolved before its children.
  for (const frame of frames) {
    const names = ownLocals(frame);
    const inherited = frame.parent === undefined ? undefined : visible.get(frame.parent);
    for (const name of inherited ?? []) {
      if (!frame.params.has(name) && !frame.declaredElsewhere.has(name)) names.add(name);
    }
    visible.set(frame, names);
  }
  const out = new Map<number, string[]>();
  for (const [frame, names] of visible) {
    if (names.size > 0) out.set(frame.line, [...names].sort());
  }
  return out;
}
