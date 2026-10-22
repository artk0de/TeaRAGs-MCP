import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
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

/**
 * Every `let NAME = <call>` of one function, at any block depth, windowed to
 * its enclosing block (`scopeEndLine`) so the resolver picks the innermost
 * shadow positionally. A name declines on its OWN evidence only — another
 * name's closure, match or macro no longer withdraws it (bd tea-rags-mcp-2g2og.24).
 */
function rustFunctionCallResultBindings(
  fn: AstNode,
  unsafeCallees: ReadonlySet<string>,
): Record<string, CallResultBinding[]> {
  const bindings: Record<string, CallResultBinding[]> = createIdentifierRecord();
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
  const evidence = new RustCallResultEvidence();
  for (const param of fn.childForFieldName("parameters")?.children ?? []) {
    if (param.type === "parameter") evidence.bindPattern(param.childForFieldName("pattern"));
  }
  if (!evidence.visit(body, false)) return bindings;
  for (const [name, candidates] of evidence.candidates) {
    if (evidence.declined.has(name)) continue;
    const provable = candidates.every(
      ({ binding, head, functionText }) =>
        !evidence.localNames.has(head) &&
        !evidence.declined.has(head) &&
        !evidence.itemNames.has(head) &&
        !unsafeCallees.has(binding.callee) &&
        !unsafeCallees.has(functionText),
    );
    // One unprovable `let` still shadows the others: dropping only it would
    // hand its window to an outer binding, so the whole name declines.
    if (provable) bindings[name] = candidates.map((candidate) => candidate.binding);
  }
  return bindings;
}

/** Std/core/log macros whose arguments only READ names; any other statement-position macro may bind one. */
const RUST_READ_ONLY_STATEMENT_MACROS = new Set([
  "assert",
  "assert_eq",
  "assert_ne",
  "assert_matches",
  "debug_assert",
  "debug_assert_eq",
  "debug_assert_ne",
  "print",
  "println",
  "eprint",
  "eprintln",
  "write",
  "writeln",
  "format",
  "format_args",
  "panic",
  "unreachable",
  "todo",
  "unimplemented",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "vec",
  "dbg",
  "matches",
]);

const RUST_READ_ONLY_MACRO_PATHS = new Set(["std", "core", "log"]);

interface RustCallResultCandidate {
  readonly binding: CallResultBinding;
  /** The callee's leading path name (`make`, `a` of `a::f`); empty for a method callee. */
  readonly head: string;
  /** The called function's own text, whatever tail the init wraps it in. */
  readonly functionText: string;
}

/**
 * Per-name evidence over one function body: which names a `let` binds from a
 * call, and which names something else binds, rebinds or hands to a macro.
 */
class RustCallResultEvidence {
  readonly candidates = new Map<string, RustCallResultCandidate[]>();
  /** Bound by a non-`let` pattern, reassigned, shadowed by a non-call `let`, or handed to a statement macro. */
  readonly declined = new Set<string>();
  /** Every name a `let` or a pattern binds — a callee spelled by one is a local value, not a function. */
  readonly localNames = new Set<string>();
  /** Names a nested fn/const/static/macro/use inside the body introduces. */
  readonly itemNames = new Set<string>();

  bindPattern(pattern: AstNode | null): void {
    if (pattern === null) return;
    for (const name of identifiersIn(pattern)) {
      this.declined.add(name);
      this.localNames.add(name);
    }
  }

  /** Walk `node`; false when a parse error leaves the whole function unprovable. */
  visit(node: AstNode, nested: boolean): boolean {
    switch (node.type) {
      case "ERROR":
        return false;
      case "function_item":
      case "const_item":
      case "static_item":
      case "macro_definition":
        return this.visitItem(node);
      case "use_declaration":
        for (const name of identifiersIn(node)) this.itemNames.add(name);
        return true;
      case "macro_invocation":
        this.visitMacro(node);
        return true;
      case "closure_expression":
        this.bindPattern(node.childForFieldName("parameters"));
        break;
      case "let_condition":
      case "for_expression":
      case "match_arm":
        this.bindPattern(node.childForFieldName("pattern"));
        break;
      case "let_declaration":
        this.visitLet(node, nested);
        break;
      case "assignment_expression":
      case "compound_assignment_expr": {
        const left = node.childForFieldName("left");
        if (left?.type === "identifier") this.declined.add(left.text);
        break;
      }
      default:
        break;
    }
    for (const child of node.children) {
      if (!this.visit(child, nested)) return false;
    }
    return true;
  }

  /**
   * A nested item's name shadows a callee. A nested fn sees no outer local,
   * but its own lines sit inside the outer windows, so every name it binds
   * declines rather than borrow an outer binding there.
   */
  private visitItem(node: AstNode): boolean {
    const name = node.childForFieldName("name");
    if (name !== null) this.itemNames.add(name.text);
    if (node.type !== "function_item") return true;
    for (const param of node.childForFieldName("parameters")?.children ?? []) {
      if (param.type === "parameter") this.bindPattern(param.childForFieldName("pattern"));
    }
    const body = node.childForFieldName("body");
    return body === null || this.visit(body, true);
  }

  private visitLet(node: AstNode, nested: boolean): void {
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type !== "identifier" || nested) {
      this.bindPattern(pattern);
      return;
    }
    const name = pattern.text;
    this.localNames.add(name);
    const block = node.parent;
    const init = rustCallResultInit(node.childForFieldName("value"));
    if (block?.type !== "block" || node.childForFieldName("type") !== null || init === null) {
      this.declined.add(name);
      return;
    }
    const list = this.candidates.get(name) ?? [];
    list.push({
      binding: {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        scopeEndLine: block.endPosition.row + 1,
        callee: init.callee,
        initExpression: init.text,
      },
      head: init.head,
      functionText: init.functionText,
    });
    this.candidates.set(name, list);
  }

  /** Only a statement-position macro outside the read-only allowlist can bind a name it is handed. */
  private visitMacro(node: AstNode): void {
    if (node.parent?.type !== "expression_statement" && node.parent?.type !== "block") return;
    const macro = node.childForFieldName("macro");
    const scoped = macro?.type === "scoped_identifier";
    const macroName = scoped ? macro.childForFieldName("name")?.text : macro?.text;
    const macroPath = scoped ? macro.childForFieldName("path")?.text : undefined;
    const readOnly =
      (macroPath === undefined || RUST_READ_ONLY_MACRO_PATHS.has(macroPath)) &&
      macroName !== undefined &&
      RUST_READ_ONLY_STATEMENT_MACROS.has(macroName);
    if (readOnly) return;
    for (const name of identifiersIn(node)) this.declined.add(name);
  }
}

/** Every `identifier` token under `node`, macro token trees included. */
function identifiersIn(node: AstNode): string[] {
  const names: string[] = [];
  const scan = (current: AstNode): void => {
    if (current.type === "identifier") names.push(current.text);
    for (const child of current.children) scan(child);
  };
  scan(node);
  return names;
}

/**
 * The call a `let` init produces, behind `&`, `&mut` and parens: any callee
 * kind, a `?` tail, or a method tail such as `.unwrap()` (itself a call).
 * `callee` stays the function text of a direct call — byte-identical to the
 * shapes recorded before; a `?` init carries its whole text, which no
 * free-function or method-return arm reads as a callee.
 */
function rustCallResultInit(
  value: AstNode | null,
): { callee: string; head: string; functionText: string; text: string } | null {
  let init = value;
  while (init?.type === "reference_expression" || init?.type === "parenthesized_expression") {
    init = init.type === "reference_expression" ? init.childForFieldName("value") : (init.namedChildren[0] ?? null);
  }
  if (init === null) return null;
  let call: AstNode | null = init;
  while (call?.type === "try_expression") call = call.namedChildren[0] ?? null;
  if (call?.type !== "call_expression") return null;
  const fn = call.childForFieldName("function");
  if (fn === null) return null;
  const text = init.text.replace(/\s+/g, " ");
  return {
    callee: init.type === "call_expression" ? fn.text : text,
    head: rustCalleeHead(fn),
    functionText: fn.text,
    text,
  };
}

/** The leading path name a callee is spelled from (`make`, `a` of `a::b::f`); empty for a method callee. */
function rustCalleeHead(fn: AstNode): string {
  let head: AstNode | null = fn;
  while (head?.type === "scoped_identifier" || head?.type === "generic_function") {
    head = head.type === "generic_function" ? head.childForFieldName("function") : head.childForFieldName("path");
  }
  return head?.type === "identifier" ? head.text : "";
}
