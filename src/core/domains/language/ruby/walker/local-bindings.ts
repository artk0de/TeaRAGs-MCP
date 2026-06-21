import type { AstNode } from "../../../../contracts/types/ast.js";
import { resolveLocalBindingType, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import { readScopeResolution, walk } from "./ast-utils.js";

/**
 * Instance-returning methods on a class constant that bind a local to the
 * receiver's INSTANCE type. `new` is the universal constructor; the rest are
 * Rails/ActiveRecord factories and finders that return a single model instance
 * (not a Relation). Methods like `where` / `order` / `joins` return a Relation,
 * so chained `.first` / `.last` need separate Relation-aware tracking (not done
 * here). This is the single source of truth for the instance-returning set
 * (bd tea-rags-mcp-va9ng will later wire it onto ResolverConfig); the walker's
 * binding inference consumes it directly. Note `new` is handled separately as
 * the universal constructor and is NOT listed here.
 */
export const INSTANCE_RETURNING_METHODS = new Set([
  "find",
  "find!",
  "find_by",
  "find_by!",
  "create",
  "create!",
  "build",
  "first",
  "last",
  "take",
]);

/**
 * Env-gate for the Ruby local variable type inference path. When `false`,
 * walker emits `localBindings: undefined` and the resolver falls back to
 * legacy import + short-name resolution. Default `true`.
 */
export function localTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/**
 * Infer the INSTANCE type of an RHS expression that is a class-constant call
 * (`ClassName.new(...)` / `Model.find(...)` / `Model.create!(...)` …). Returns
 * the fully-qualified constant name when the receiver is a constant and the
 * method is `new` or in {@link INSTANCE_RETURNING_METHODS}; otherwise null
 * (bare factory calls, Relation tails, non-constant receivers — never guessed).
 */
function constInstanceType(node: AstNode): string | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  const receiver = node.childForFieldName("receiver");
  const method = node.childForFieldName("method");
  if (!receiver || !method) return null;
  const receiverText = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
  if (!YARD_CONST.test(receiverText)) return null;
  const methodName = method.text;
  // `ClassName.new(...)` is the universal Ruby constructor; the rest are
  // instance-returning factories / finders that bind to the receiver class.
  if (methodName === "new" || INSTANCE_RETURNING_METHODS.has(methodName)) return receiverText;
  return null;
}

/**
 * Collect position-aware `varName → LocalBinding[]` bindings inside the given
 * line range. Each binding carries the 1-based source line where it is
 * established; a call site resolves against the most-recent binding at or before
 * its own line (`resolveLocalBindingType`), making `var.method()` resolution
 * flow-sensitive — reassignment to a different type is the correct answer per
 * call site, not a conflict.
 *
 * Sources scanned (pushed in source order so the position-aware lookup sees the
 * correct most-recent binding):
 *
 *   1. YARD `@param NAME [TYPE]` comments preceding `def NAME(...)` — bound at
 *      the `def` line (the parameter is in scope from method entry).
 *   2. Constructor / factory / finder assignments (`var = ClassName.new(...)`,
 *      `var = Model.find/find!/find_by/create/create!/build/first/last/take`).
 *   3. Copy propagation (`var = other_var`) — copies `other_var`'s most-recent
 *      type known at this line.
 *   4. Multiple assignment (`a, b = X.new, Y.new`) — paired positionally when
 *      arities match; splat / uneven arity is skipped.
 *   5. Param-default inference (`def f(x = User.new)`) — binds `x` for the
 *      method body at the `def` line.
 *
 * Sources deliberately NOT inferred:
 *   - Bare factory calls (`var = make_user()`) — no class name to attribute.
 *   - Chained Relation tails (`Model.where(...).first`) — `.where` returns
 *     a Relation, we'd need Relation-aware tracking. Bare `Model.first`
 *     IS inferred (the chain root is the Model class itself).
 *   - `var = CONST` constant-reference (var holds the class, not an instance) —
 *     deferred; needs a class-valued binding kind.
 *   - Block parameters and untyped params — need container/element typing (VTA).
 */
export function collectLocalBindingsForChunk(
  root: AstNode,
  startLine: number,
  endLine: number,
  yardByLine: Map<number, Record<string, string>>,
): Record<string, LocalBinding[]> {
  const out: Record<string, LocalBinding[]> = {};
  const push = (name: string, type: string, line: number): void => {
    (out[name] ??= []).push({ line, type });
  };

  // YARD `@param` bindings — attach to the def whose line falls in the chunk
  // range. `yardByLine` is keyed by the line of the `def` keyword; the param is
  // in scope from method entry, so the binding line is the `def` line.
  for (const [defLine, params] of yardByLine.entries()) {
    if (defLine < startLine || defLine > endLine) continue;
    for (const [name, type] of Object.entries(params)) push(name, type, defLine);
  }

  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;

    // Param-default inference: `def f(x = User.new)` binds `x` for the body at
    // the `def` line. Block params / untyped params are skipped (VTA scope).
    if (node.type === "method" || node.type === "singleton_method") {
      const params = node.childForFieldName("parameters");
      if (params) {
        for (const param of params.namedChildren) {
          if (param.type !== "optional_parameter") continue;
          const nameNode = param.childForFieldName("name");
          const valueNode = param.childForFieldName("value");
          if (nameNode?.type !== "identifier" || !valueNode) continue;
          const type = constInstanceType(valueNode);
          if (type) push(nameNode.text, type, line);
        }
      }
      return;
    }

    if (node.type !== "assignment") return;
    const lhs = node.childForFieldName("left");
    const rhs = node.childForFieldName("right");
    if (!lhs || !rhs) return;

    // Multiple assignment: `a, b = X.new, Y.new`. Pair positionally only when
    // the LHS identifier count matches the RHS element count (splat / uneven
    // arity is skipped — no guessing).
    if (lhs.type === "left_assignment_list" && rhs.type === "right_assignment_list") {
      const targets = lhs.namedChildren;
      const values = rhs.namedChildren;
      if (targets.length !== values.length) return;
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const value = values[i];
        if (target?.type !== "identifier" || !value) continue;
        const type =
          constInstanceType(value) ??
          (value.type === "identifier" ? resolveLocalBindingType(out, value.text, line) : undefined);
        if (type) push(target.text, type, line);
      }
      return;
    }

    if (lhs.type !== "identifier") return;
    const varName = lhs.text;

    // Single assignment: class-constant instance call, else copy-propagation
    // (`var = other_var` copies other_var's most-recent type known at this line).
    const type =
      constInstanceType(rhs) ?? (rhs.type === "identifier" ? resolveLocalBindingType(out, rhs.text, line) : undefined);
    if (type) push(varName, type, line);
  });
  return out;
}

/**
 * A bare-bracket YARD type — `[Foo]`, `[Acme::User]` — captured to a single
 * constant name. `null` for any shape we deliberately do NOT bind (union types
 * `[A, B]`, hashes `[Hash{...}]`, lowercase / non-constant tokens). The one
 * structured form we DO unwrap is a single-element collection container
 * (`Array<T>` / `Enumerable<T>` / `[T]`-style) whose element type is itself a
 * bare constant — `@param x [Array<Post>]` binds the ELEMENT type `Post`
 * (brg9), because `x` is iterated/element-accessed in the body, not used as an
 * Array (bd cai0/brg9).
 */
export const YARD_CONST = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;
const YARD_ELEMENT_CONTAINER = /^(?:Array|Enumerable|Set|Collection|ActiveRecord::Relation)<([\w:]+)>$/;

function parseYardBracketType(inner: string): string | null {
  const trimmed = inner.trim();
  // `Array<Post>` / `Enumerable<Acme::Post>` → element type.
  const container = YARD_ELEMENT_CONTAINER.exec(trimmed);
  if (container) {
    const element = container[1];
    return YARD_CONST.test(element) ? element : null;
  }
  // Bare constant `Foo` / `Acme::User`.
  return YARD_CONST.test(trimmed) ? trimmed : null;
}

/**
 * Parse YARD `# @param NAME [TYPE]` lines and group them by the line
 * number of the `def NAME(...)` they precede. The grammar is light: any
 * comment line matching the pattern attaches to the NEXT non-comment,
 * non-blank line that starts with `def` (with optional `self.` prefix).
 *
 * `[TYPE]` is parsed by `parseYardBracketType`: a bare constant binds
 * directly; a single-element collection (`Array<T>`) binds the ELEMENT type
 * `T` (brg9) so `x.first` / `x.each { |e| … }` element-method calls resolve.
 * Bracket-less types (`# @param x String`), unions, and lowercase tokens are
 * rejected — the bracket form is the canonical Sorbet/Solargraph/Steep
 * convention.
 */
export function collectYardParamTypes(code: string): Map<number, Record<string, string>> {
  const lines = code.split(/\r?\n/);
  const out = new Map<number, Record<string, string>>();
  let pending: Record<string, string> | null = null;
  const yardRegex = /^\s*#\s*@param\s+(\w+)\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const yardMatch = yardRegex.exec(raw);
    if (yardMatch) {
      // SAFETY: regex capture groups (\w+) and ([^\]]+) are non-optional —
      // a successful match guarantees both name and the bracket body exist.
      const [, name, bracket] = yardMatch;
      const type = parseYardBracketType(bracket);
      if (type) {
        if (!pending) pending = {};
        pending[name] = type;
      }
      continue;
    }
    // Blank or other comment — preserve pending block.
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    // First non-blank, non-comment line. If it's a `def`, attach.
    if (pending && defRegex.test(raw)) {
      out.set(i + 1, pending);
    }
    pending = null;
  }
  return out;
}

/**
 * Parse YARD `# @return [TYPE]` lines and key them by the method NAME of the
 * `def NAME(...)` they precede (brg9). Mirrors `collectYardParamTypes`'
 * comment-block attachment, but produces a `functionName → returnTypeName`
 * map matching `FileExtraction.functionReturnTypes` (the same channel the Go
 * walker fills) so a resolver can bind `x = obj.foo` to `foo`'s return type.
 *
 * Only a SINGLE bare constant return is recorded — `[Array<User>]` and other
 * collection containers are skipped (a collection isn't a single instance the
 * caller's `x.method` dispatches on), matching the Go walker's "single concrete
 * return only" discipline. `parseYardBracketType` would unwrap the element type
 * for a param, but a `@return` of a collection genuinely IS a collection, so we
 * reject containers here rather than unwrap them.
 */
export function collectYardReturnTypes(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  let pendingReturn: string | null = null;
  const returnRegex = /^\s*#\s*@return\s+\[([^\]]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (const raw of code.split(/\r?\n/)) {
    const m = returnRegex.exec(raw);
    if (m) {
      const inner = (m[1] ?? "").trim();
      // Single bare constant only — a collection `[Array<T>]` return is a
      // collection, not a dispatch target, so it is NOT recorded.
      pendingReturn = YARD_CONST.test(inner) ? inner : null;
      continue;
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const defMatch = defRegex.exec(raw);
    // defMatch[1] is the method name (\w+) when the line is a `def`.
    if (pendingReturn && defMatch?.[1]) {
      out[defMatch[1]] = pendingReturn;
    }
    pendingReturn = null;
  }
  return out;
}
