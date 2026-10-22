import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { CallResultBinding } from "../../../../contracts/types/codegraph.js";
import { letConditionScope, matchArmPattern } from "./pattern-bindings.js";
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
    if (param.type === "parameter") evidence.bindParameter(param.childForFieldName("pattern"));
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
    if (!provable) continue;
    const shadows = evidence.patternShadows.get(name) ?? [];
    bindings[name] = candidates.flatMap((candidate) => windowOutsideShadows(candidate.binding, shadows));
  }
  return bindings;
}

type AstPosition = AstNode["startPosition"];

/** Rows (1-based, inclusive) where a pattern's own binding of a name shadows every outer one. */
interface RustPatternShadowRows {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Cut `binding`'s window `(endLine, scopeEndLine]` around every pattern shadow
 * that opens inside it (bd tea-rags-mcp-s3i8m): each remaining piece is one
 * row with the same `line`, so the reader's latest-`let` rule is unchanged. A
 * shadow that holds the `let` itself is the binding's own enclosing scope, not
 * a hole in it. No shadow → the binding exactly as recorded.
 */
function windowOutsideShadows(
  binding: CallResultBinding,
  shadows: readonly RustPatternShadowRows[],
): CallResultBinding[] {
  const { endLine, scopeEndLine } = binding;
  if (endLine === undefined || scopeEndLine === undefined) return [binding];
  const holes = shadows
    .filter((shadow) => shadow.startLine > endLine && shadow.startLine <= scopeEndLine)
    .sort((a, b) => a.startLine - b.startLine);
  if (holes.length === 0) return [binding];
  const entries: CallResultBinding[] = [];
  let from = endLine;
  for (const hole of holes) {
    if (hole.startLine - 1 > from) entries.push({ ...binding, endLine: from, scopeEndLine: hole.startLine - 1 });
    from = Math.max(from, hole.endLine);
  }
  if (scopeEndLine > from) entries.push({ ...binding, endLine: from, scopeEndLine });
  return entries;
}

/**
 * The rows a pattern's names shadow: those strictly inside the span from
 * `scopeStart` to `scopeEnd`. A boundary row is shared with code outside the
 * pattern — the scrutinee of `if let Some(x) = x.take() {`, a closure's
 * enclosing `let`, a destructuring `let`'s own last row — and there the
 * column-scoped pattern binding (`visibleSpan`) already outranks this channel
 * for a call inside the span. `null` when no row is wholly inside.
 */
function shadowRowsOf(scopeStart: AstPosition, scopeEnd: AstPosition): RustPatternShadowRows | null {
  const startLine = scopeStart.row + 2;
  const endLine = scopeEnd.row;
  return endLine >= startLine ? { startLine, endLine } : null;
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
  /** Bound by a parameter or an unscoped pattern, reassigned, shadowed by a non-call `let`, or handed to a statement macro. */
  readonly declined = new Set<string>();
  /** Every name a `let` or a pattern binds — a callee spelled by one is a local value, not a function. */
  readonly localNames = new Set<string>();
  /** Names a nested fn/const/static/macro/use inside the body introduces. */
  readonly itemNames = new Set<string>();
  /** Per name, the rows an `if let` / `while let` / match arm / `for` / closure pattern rebinds it in. */
  readonly patternShadows = new Map<string, RustPatternShadowRows[]>();

  bindPattern(pattern: AstNode | null): void {
    if (pattern === null) return;
    for (const name of patternNamesIn(pattern)) {
      this.declined.add(name);
      this.localNames.add(name);
    }
  }

  /**
   * The function's own parameter: bound before every `let` of the body, so a
   * `let sink = Some(sink)` that rebinds it opens its window after the
   * parameter's — positionally the later binding, never an overlap.
   */
  bindParameter(pattern: AstNode | null): void {
    if (pattern === null) return;
    for (const name of patternNamesIn(pattern)) this.localNames.add(name);
  }

  /**
   * A scoped pattern rebinds its names only from `scopeStart` to `scopeEnd` —
   * the walker records those bindings positionally (bd tea-rags-mcp-s3i8m 1a),
   * so an outer call-result `let` of the same name stays valid around them.
   * A pattern with no scope (a `let` condition outside `if` / `while`) or
   * inside a nested fn declines, as every other name a nested fn binds does.
   */
  private shadowPattern(
    pattern: AstNode | null,
    scopeStart: AstPosition | undefined,
    scopeEnd: AstPosition | undefined,
    nested: boolean,
  ): void {
    if (pattern === null) return;
    if (scopeStart === undefined || scopeEnd === undefined || nested) {
      this.bindPattern(pattern);
      return;
    }
    const shadowRows = shadowRowsOf(scopeStart, scopeEnd);
    for (const name of patternNamesIn(pattern)) {
      this.localNames.add(name);
      if (shadowRows === null) continue;
      const list = this.patternShadows.get(name) ?? [];
      list.push(shadowRows);
      this.patternShadows.set(name, list);
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
      case "closure_expression": {
        const body = node.childForFieldName("body") ?? node;
        this.shadowPattern(node.childForFieldName("parameters"), body.startPosition, body.endPosition, nested);
        break;
      }
      case "let_condition": {
        const scope = letConditionScope(node);
        this.shadowPattern(node.childForFieldName("pattern"), scope?.startPosition, scope?.endPosition, nested);
        break;
      }
      case "for_expression": {
        const body = node.childForFieldName("body");
        this.shadowPattern(node.childForFieldName("pattern"), body?.startPosition, body?.endPosition, nested);
        break;
      }
      case "match_arm": {
        // The guard reads the arm's names, so the shadow spans pattern through arm end.
        const pattern = matchArmPattern(node);
        this.shadowPattern(pattern, pattern?.startPosition, node.endPosition, nested);
        break;
      }
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
    const block = node.parent;
    if (pattern?.type !== "identifier" || nested) {
      // A destructuring `let` (`let Some(x) = x.get() else { … };`) rebinds its
      // names from its end through its block — its scrutinee and `else` read the outer.
      this.shadowPattern(pattern, node.endPosition, block?.endPosition, nested);
      return;
    }
    const name = pattern.text;
    this.localNames.add(name);
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

/**
 * The names a pattern binds: its lowercase identifiers. A CapWords one is the
 * variant or unit struct the pattern matches (`Some` of `Some(x)`), never a
 * binding — the rule `unfoldPattern` reads the same pattern by.
 */
function patternNamesIn(pattern: AstNode): string[] {
  return identifiersIn(pattern).filter((name) => !/^[A-Z]/.test(name));
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
