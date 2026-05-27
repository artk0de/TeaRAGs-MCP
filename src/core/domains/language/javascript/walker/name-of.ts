/**
 * JavaScript `nameOf` — maps a tree-sitter node to its `NamedSymbol`
 * descriptor(s) for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`jsNameOf` + its private
 * helper web) into the native JavaScript language provider per the
 * `domains/language` consolidation (spec §3; bd tea-rags-mcp-cen6, following the
 * ruby + typescript verticals). Behaviour-preserving: the node-shape detection
 * and symbol emission are identical to the provider's former inline functions.
 *
 * `jsNameOf` delegates first to `tsNameOf` for the ES2015 class surface
 * (function_declaration / method_definition / class_declaration) — IMPORTED
 * from the sibling TypeScript vertical's `walker/name-of.ts` rather than kept as
 * a local copy. JavaScript and TypeScript share that grammar surface, so the TS
 * implementation is the single source of truth for it (`.claude/rules/symbolid-convention.md`).
 * On top of the delegation, this module adds the CommonJS / pre-class shapes
 * that have no TypeScript analogue:
 *
 *   #1  obj.method = function () {}              → emit `obj.method`
 *   #2  Foo.prototype.bar = function () {}       → emit `Foo#bar` (instance)
 *   #3  exports.foo = function () {}             → emit top-level `foo`
 *   #4  module.exports = function name() {}      → emit top-level `name`
 *                                                  (skip if anonymous)
 *   #5  const Foo = function () {} | arrow       → emit `Foo` (also let / var)
 *   #6  res.a = res.b = function () {}           → emit BOTH res.a AND res.b
 *   #7  Object.defineProperty / defineGetter     → emit `<obj>.<name>`
 *   #8  <methods>.forEach(m => obj[m] = fn)       → emit one symbol per HTTP verb
 *
 * bd tea-rags-mcp-mwty / d1f8 / z95o / mk45.
 */

import type Parser from "tree-sitter";

import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../../infra/symbolid/index.js";
import { tsNameOf } from "../../typescript/walker/name-of.js";

export function jsNameOf(node: Parser.SyntaxNode): NamedSymbol | NamedSymbol[] | null {
  // Delegate first — TS-style declarations dominate modern JS too.
  const tsResult = tsNameOf(node);
  if (tsResult) {
    // bd tea-rags-mcp-mk45 — pre-ES6 constructor function pattern:
    //   function Foo(...) { this.x = ... }
    //   Foo.prototype.bar = function () {...}
    // The function_declaration alone looks like a plain top-level function;
    // the `Foo.prototype.X = fn` siblings are the strong signal that `Foo`
    // is a constructor. When detected, mark the function_declaration as a
    // synthetic-constructor source so the collector emits `Foo#constructor`.
    if (!Array.isArray(tsResult) && node.type === "function_declaration" && isJsConstructorFunction(node)) {
      return { ...tsResult, syntheticConstructorIfMissing: true };
    }
    return tsResult;
  }

  // Pattern #5: `const|let|var Foo = function () {}` / arrow / function name.
  // Wrapped in `lexical_declaration` (const/let) or `variable_declaration`
  // (var). We attach to the inner `variable_declarator` so each declarator
  // in a comma list (`const a = fn1, b = fn2`) is treated independently.
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) return null;
    if (nameNode.type !== "identifier") return null;
    if (!isFunctionValuedExpression(valueNode)) return null;
    return { name: nameNode.text, descendsInto: false };
  }

  // Patterns #1-#4, #6: `<lhs> = <function-valued rhs>`. The outermost
  // assignment_expression of a chain is what we descend on; chained inner
  // assignments are walked transitively via `collectAssignmentTargets`.
  // We only emit at the OUTER node so each chained LHS produces exactly
  // one symbol (the inner assignment_expression nodes return null at
  // their own visit).
  if (node.type === "assignment_expression") {
    // Skip if this assignment_expression is itself the RHS of another
    // assignment_expression — the outer visit will handle the whole chain.
    if (node.parent?.type === "assignment_expression") return null;
    const terminalRhs = walkAssignmentChainToTerminalRhs(node);
    if (!terminalRhs || !isFunctionValuedExpression(terminalRhs)) return null;
    const targets: NamedSymbol[] = [];
    collectAssignmentTargets(node, terminalRhs, targets);
    return targets.length === 0 ? null : targets.length === 1 ? targets[0] : targets;
  }

  // Pattern #7 (bd tea-rags-mcp-d1f8): JS getter helpers.
  //   Object.defineProperty(obj, 'name', { get: fn, set: fn })  → `<obj>.name`
  //   defineGetter(obj, 'name', fn)                              → `<obj>.name`
  // Both shapes are `call_expression`. Receiver text is taken verbatim
  // from the `<obj>` argument expression — when `obj` is the literal
  // `this`, the emitted name is `this.name` (resolving `this` to its
  // enclosing class would require additional scope tracking and is out
  // of scope for this fix).
  if (node.type === "call_expression") {
    const getter = jsGetterHelperEmission(node);
    if (getter) return getter;
    // Pattern #8 (bd tea-rags-mcp-z95o): HTTP-verb dispatch via
    //   <pkg>.forEach(function(<param>) { <obj>[<param>] = <fn>; });
    // where <pkg> resolves to the npm `methods` package via require().
    // Returns one NamedSymbol per HTTP verb; the array form tells
    // collectSymbols to emit each at the same scope.
    const dispatch = jsForEachDispatchEmission(node);
    if (dispatch) return dispatch;
  }

  return null;
}

/**
 * Recognise the `<methods>.forEach(method => obj[method] = fn)` HTTP-verb
 * dispatch pattern from express's `lib/application.js`.
 *
 * Returns one NamedSymbol per known HTTP verb (`<obj>.get`, `<obj>.post`, …)
 * — the array return form tells `collectSymbols` to emit each at the same
 * scope without descending.
 *
 * Conservative — only fires when:
 *   1. callee shape is `<recvIdent>.forEach(<fn-expr>)`.
 *   2. The argument is a `function_expression` / `arrow_function` with
 *      exactly one parameter (an identifier).
 *   3. The function body contains `<objIdent>[<paramName>] = <function-valued>`.
 *   4. At least ONE of the following HTTP-verb signals holds:
 *      a. `<recvIdent>` resolves via a sibling `require('methods')` (npm
 *         package), OR
 *      b. `<recvIdent>` is `methods` AND the file imports a local
 *         utility module whose path contains `util` (express does
 *         `var methods = require('./utils').methods`), OR
 *      c. The function body contains string-literal HTTP-verb comparisons
 *         like `method === 'get'` — the STRONGEST signal that the
 *         callback iterates HTTP verbs. Catches express directly
 *         regardless of the `methods` source.
 *
 * Generic case (arbitrary user array WITHOUT any HTTP-verb signal) is
 * structurally unresolvable without runtime info — out of scope.
 * bd tea-rags-mcp-z95o.
 */
function jsForEachDispatchEmission(node: Parser.SyntaxNode): NamedSymbol[] | null {
  const callee = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (!callee || !args) return null;
  if (callee.type !== "member_expression") return null;
  const recv = callee.childForFieldName("object");
  const method = callee.childForFieldName("property");
  if (!recv || !method) return null;
  if (recv.type !== "identifier") return null;
  if (method.type !== "property_identifier" || method.text !== "forEach") return null;

  const fnArg = args.namedChildren[0];
  if (!fnArg || !isFunctionValuedExpression(fnArg)) return null;
  const params = fnArg.childForFieldName("parameters");
  if (!params) return null;
  const paramIds = params.namedChildren.filter((c) => c.type === "identifier");
  if (paramIds.length !== 1) return null;
  const paramName = paramIds[0].text;

  const body = fnArg.childForFieldName("body");
  if (!body) return null;

  // Find the subscript assignment inside the body. Tree-sitter wraps it as
  // `expression_statement -> assignment_expression`.
  const assignment = findFirstSubscriptDispatchAssignment(body, paramName);
  if (!assignment) return null;
  const lhs = assignment.childForFieldName("left");
  if (lhs?.type !== "subscript_expression") return null;
  const objNode = lhs.childForFieldName("object");
  if (objNode?.type !== "identifier") return null;
  const objText = objNode.text;

  const root = findRoot(node);
  if (!root) return null;

  // Apply HTTP-verb signal heuristics — accept the dispatch if ANY holds.
  if (!hasHttpVerbDispatchSignal(root, recv.text, body, paramName)) return null;

  return HTTP_VERBS.map((verb) => ({ name: `${objText}.${verb}`, descendsInto: false }));
}

/**
 * Return true if the file (rooted at `root`) carries any signal that the
 * forEach receiver `recvName` iterates HTTP verbs. Three heuristics —
 * any one is sufficient (most specific first):
 *
 *   1. Body contains string-literal HTTP-verb comparisons like
 *      `<paramName> === 'get'`. Strongest — direct evidence the
 *      callback dispatches on HTTP verb tokens.
 *   2. `recvName === "methods"` AND a sibling require imports the npm
 *      `methods` package (`var methods = require('methods')`).
 *   3. `recvName === "methods"` AND a sibling require imports a local
 *      module whose path contains "util" (express does
 *      `var methods = require('./utils').methods`).
 *
 * bd tea-rags-mcp-z95o.
 */
function hasHttpVerbDispatchSignal(
  root: Parser.SyntaxNode,
  recvName: string,
  body: Parser.SyntaxNode,
  paramName: string,
): boolean {
  if (bodyComparesParamToHttpVerb(body, paramName)) return true;
  if (recvName === "methods") {
    const requireSource = findRequireSource(root, recvName);
    if (requireSource === "methods") return true;
    if (anyImportPathContainsUtil(root)) return true;
  }
  return false;
}

/**
 * Walk the function body looking for `<paramName> === <"http-verb">` or
 * `<"http-verb"> === <paramName>` binary expressions. Tree-sitter parses
 * `===` as `binary_expression` with operator child `===`. The string
 * argument must be one of HTTP_VERBS to count.
 */
function bodyComparesParamToHttpVerb(body: Parser.SyntaxNode, paramName: string): boolean {
  let found = false;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator");
      const opText = op?.text ?? "";
      if (opText === "===" || opText === "==") {
        const left = n.childForFieldName("left");
        const right = n.childForFieldName("right");
        if (left && right) {
          if (isParamIdentifier(left, paramName) && isHttpVerbStringLiteral(right)) {
            found = true;
            return true;
          }
          if (isParamIdentifier(right, paramName) && isHttpVerbStringLiteral(left)) {
            found = true;
            return true;
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(body);
  return found;
}

function isParamIdentifier(n: Parser.SyntaxNode, paramName: string): boolean {
  return n.type === "identifier" && n.text === paramName;
}

function isHttpVerbStringLiteral(n: Parser.SyntaxNode): boolean {
  const s = readStringLiteral(n);
  if (s === null) return false;
  return (HTTP_VERBS as readonly string[]).includes(s.toLowerCase());
}

/**
 * Walk the program root and return true if any `variable_declarator`'s
 * RHS is a `require(<path>)` (or `require(<path>).<member>`) call where
 * the require'd path is a local file (starts with `./` or `../`) whose
 * filename contains `util`. Bonus heuristic for the
 * `var methods = require('./utils').methods` express pattern.
 */
function anyImportPathContainsUtil(root: Parser.SyntaxNode): boolean {
  let found = false;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      const args = n.childForFieldName("arguments");
      if (callee?.type === "identifier" && callee.text === "require" && args) {
        const stringArg = args.namedChildren.find((c) => c.type === "string");
        if (stringArg) {
          const src = readStringLiteral(stringArg);
          if (src !== null && (src.startsWith("./") || src.startsWith("../")) && /util/i.test(src)) {
            found = true;
            return true;
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return found;
}

/**
 * The npm `methods` package — set of HTTP verbs Express dispatches.
 * Pinned to the historic list (express has always used these nine).
 * If the underlying npm package gains/loses verbs, this list stays a
 * conservative subset — extra walker symbols don't harm correctness;
 * missing ones simply revert to the pre-z95o behavior of "no symbol".
 */
const HTTP_VERBS = ["get", "post", "put", "delete", "head", "options", "patch", "connect", "trace"] as const;

/**
 * Walk `body` (a statement_block) and return the first
 * `assignment_expression` whose LHS is `<obj>[<paramName>]`. Used by the
 * forEach-dispatch detector to anchor the receiver-name extraction.
 */
function findFirstSubscriptDispatchAssignment(body: Parser.SyntaxNode, paramName: string): Parser.SyntaxNode | null {
  let found: Parser.SyntaxNode | null = null;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left?.type === "subscript_expression" && right && isFunctionValuedExpression(right)) {
        const idx = left.childForFieldName("index");
        if (idx?.type === "identifier" && idx.text === paramName) {
          found = n;
          return true;
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(body);
  return found;
}

/**
 * Walk `root` to find a `variable_declarator` of shape
 *   <recvName> = require('<source>')
 * and return the source string. Returns null if no such declarator
 * exists. Used to validate that a `forEach` receiver originates from
 * a known package.
 */
function findRequireSource(root: Parser.SyntaxNode, recvName: string): string | null {
  let found: string | null = null;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found !== null) return true;
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      if (name?.type === "identifier" && name.text === recvName && value?.type === "call_expression") {
        const callee = value.childForFieldName("function");
        const args = value.childForFieldName("arguments");
        if (callee?.type === "identifier" && callee.text === "require" && args) {
          const stringArg = args.namedChildren.find((c) => c.type === "string");
          if (stringArg) {
            const src = readStringLiteral(stringArg);
            if (src !== null) {
              found = src;
              return true;
            }
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return found;
}

/**
 * Recognise the two project-supported "install a getter" shapes and
 * return a NamedSymbol for the installed name. Returns null for any
 * other call_expression.
 *
 * Shape A — `Object.defineProperty(<obj>, <"name">, { get: fn, ... })`.
 * The descriptor object must contain at least one `get:` or `set:`
 * function-valued pair; a plain `{ value: 1 }` descriptor is data, not
 * a callable, and is skipped.
 *
 * Shape B — `defineGetter(<obj>, <"name">, <fn>)`. Project-specific
 * helper (express `lib/request.js`); recognised by exact callee text
 * `defineGetter` and third argument being a function value.
 */
function jsGetterHelperEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  const callee = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (!callee || !args) return null;
  const namedArgs = args.namedChildren;
  if (namedArgs.length < 3) return null;

  // Shape A: Object.defineProperty(obj, name, descriptor)
  if (callee.type === "member_expression") {
    const obj = callee.childForFieldName("object");
    const prop = callee.childForFieldName("property");
    if (
      obj?.type === "identifier" &&
      obj.text === "Object" &&
      prop?.type === "property_identifier" &&
      prop.text === "defineProperty"
    ) {
      const receiver = namedArgs[0];
      const nameArg = namedArgs[1];
      const descriptor = namedArgs[2];
      if (!receiver || !nameArg || !descriptor) return null;
      const propName = readStringLiteral(nameArg);
      if (!propName) return null;
      if (descriptor.type !== "object") return null;
      if (!objectHasGetterPair(descriptor)) return null;
      const receiverText = resolveReceiverText(receiver);
      if (!receiverText) return null;
      // `absolute: true` when receiver was `this` and we rewrote it via
      // enclosing-assignment lookup — the emitted name is the FULLY
      // resolved sibling of the outer assignment target, not a child of
      // the enclosing function's scope. bd tea-rags-mcp-d1f8 this-resolve.
      const absolute = receiver.type === "this";
      return { name: `${receiverText}.${propName}`, descendsInto: false, absolute };
    }
  }

  // Shape B: defineGetter(obj, name, fn) — project-specific helper.
  if (callee.type === "identifier" && callee.text === "defineGetter") {
    const receiver = namedArgs[0];
    const nameArg = namedArgs[1];
    const fnArg = namedArgs[2];
    if (!receiver || !nameArg || !fnArg) return null;
    const propName = readStringLiteral(nameArg);
    if (!propName) return null;
    if (!isFunctionValuedExpression(fnArg)) return null;
    const receiverText = resolveReceiverText(receiver);
    if (!receiverText) return null;
    const absolute = receiver.type === "this";
    return { name: `${receiverText}.${propName}`, descendsInto: false, absolute };
  }

  return null;
}

/**
 * Render the receiver of a `defineProperty` / `defineGetter` call as the
 * text used in the emitted symbolId, with `this` resolution.
 *
 * For non-`this` receivers (plain identifier, `exports.proto` chain) this
 * is identical to `receiverDisplayText` — verbatim text.
 *
 * For `this` we look upward to find an enclosing `function_expression` /
 * `function_declaration` that is the RHS of an outer assignment to a
 * receiver-rooted LHS (e.g. `app.init = function init() { … }`). When
 * found, the `this` token rebinds to that outer receiver — emit
 * `<outer-receiver>.<name>` instead of literal `this.<name>`. This catches
 * express's `app.init = function () { Object.defineProperty(this, 'router',
 * …); }` so we surface `app.router` rather than the misleading
 * `app.init.this.router` chain. bd tea-rags-mcp-d1f8 this-resolve.
 *
 * Free-floating `this` (top-level, no enclosing receiver-rooted assignment)
 * returns null — those references are unresolvable and emission is skipped
 * by the caller.
 */
function resolveReceiverText(receiver: Parser.SyntaxNode): string | null {
  if (receiver.type !== "this") return receiverDisplayText(receiver);
  const outer = resolveEnclosingThisReceiver(receiver);
  return outer; // null when no enclosing receiver — caller will skip.
}

/**
 * Walk `node.parent` upward looking for the outermost enclosing
 * function-valued expression that is the RHS of an outer
 * `<receiver>.<member> = function … { … }` assignment. Return the
 * receiver text (e.g. `"app"`, `"exports.proto"`) when found, else null.
 *
 * Arrow-function `this` would inherit from the enclosing lexical scope; we
 * still walk further out so nested arrow inside `app.init = function() {}`
 * still resolves to `app`. The chain stops at any non-callable parent.
 */
function resolveEnclosingThisReceiver(node: Parser.SyntaxNode): string | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (
      cur.type === "function_expression" ||
      cur.type === "function_declaration" ||
      cur.type === "generator_function" ||
      cur.type === "generator_function_declaration"
    ) {
      // A non-arrow function rebinds `this` — we look at its assignment context.
      const fn = cur;
      const fnParent = fn.parent;
      if (fnParent?.type === "assignment_expression") {
        const right = fnParent.childForFieldName("right");
        // Confirm the function is on the RHS of the assignment.
        if (right === fn) {
          const left = fnParent.childForFieldName("left");
          if (left?.type === "member_expression") {
            const obj = left.childForFieldName("object");
            if (obj) {
              const text = receiverDisplayText(obj);
              if (text) return text;
            }
          }
        }
      }
      // Non-arrow function with no receiver-rooted assignment context.
      // `this` is unresolvable from here — stop walking (further outer
      // scopes won't bind this function's `this`).
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Read the text of a string-literal arg.
 *
 * tree-sitter-javascript wraps strings as `string` with a `string_fragment`
 * child; template strings without interpolation parse as `template_string`.
 * Templates with interpolation are dynamic — skip them.
 */
function readStringLiteral(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const frag = node.namedChildren.find((c) => c.type === "string_fragment");
    return frag ? frag.text : null;
  }
  if (node.type === "template_string") {
    // No-interpolation template — accept; with interpolation — reject.
    const hasInterp = node.namedChildren.some((c) => c.type === "template_substitution");
    if (hasInterp) return null;
    return node.text.replace(/^`|`$/g, "");
  }
  return null;
}

/**
 * Render the receiver expression as the text used in the emitted symbol.
 * Accepts plain identifiers (`app`, `req`), `this`, and member chains
 * (`exports.proto`). Returns null for shapes we can't render cleanly
 * (computed access, calls, etc.).
 */
function receiverDisplayText(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "this") return "this";
  if (node.type === "member_expression") {
    // Static member chain like `exports.proto` — emit literal text.
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (!obj || !prop) return null;
    if (prop.type !== "property_identifier") return null;
    const objText = receiverDisplayText(obj);
    if (!objText) return null;
    return `${objText}.${prop.text}`;
  }
  return null;
}

/**
 * Inspect an object literal for `get:` or `set:` pairs whose value is a
 * function. Used to filter `Object.defineProperty(obj, 'x', { value: 1 })`
 * (data descriptor — not a getter) from the getter form we care about.
 */
function objectHasGetterPair(node: Parser.SyntaxNode): boolean {
  for (const pair of node.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (!key || !value) continue;
    const keyText =
      key.type === "property_identifier" || key.type === "string" ? (readStringLiteral(key) ?? key.text) : null;
    if (keyText !== "get" && keyText !== "set") continue;
    if (isFunctionValuedExpression(value)) return true;
  }
  return false;
}

/**
 * Detect a pre-ES6 constructor function (bd tea-rags-mcp-mk45).
 *
 * Returns true when the file containing `node` (a `function_declaration`)
 * has at least one sibling assignment of the form
 * `<name>.prototype.<method> = <function-valued expr>` where `<name>` is
 * the function's identifier. The prototype-assignment sibling is the
 * canonical signal — uppercase-naming alone is too weak (many factory
 * functions follow PascalCase).
 *
 * Memoised per tree-rootNode via WeakMap so the cost is O(n) per file
 * instead of O(n^2) over `collectSymbols`' walk.
 */
function isJsConstructorFunction(node: Parser.SyntaxNode): boolean {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return false;
  const fnName = nameNode.text;
  const root = findRoot(node);
  if (!root) return false;
  const set = constructorFunctionNamesForRoot(root);
  return set.has(fnName);
}

const constructorNamesCache = new WeakMap<Parser.SyntaxNode, Set<string>>();

function constructorFunctionNamesForRoot(root: Parser.SyntaxNode): Set<string> {
  const cached = constructorNamesCache.get(root);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (n: Parser.SyntaxNode): void => {
    // Look for `Foo.prototype.X = <function>` at the assignment_expression
    // level. The walker already understands this shape in
    // `lhsToNamedSymbol` (pattern #2); here we only need the receiver name.
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const terminalRhs = right ? walkAssignmentChainToTerminalRhs(right) : null;
      if (left?.type === "member_expression" && terminalRhs && isFunctionValuedExpression(terminalRhs)) {
        const outerObj = left.childForFieldName("object");
        const outerProp = left.childForFieldName("property");
        // Match `<obj>.prototype.<method>` — outer object is itself a
        // member_expression whose property is the literal `prototype`.
        if (outerObj?.type === "member_expression" && outerProp?.type === "property_identifier") {
          const innerObj = outerObj.childForFieldName("object");
          const innerProp = outerObj.childForFieldName("property");
          if (
            innerObj?.type === "identifier" &&
            innerProp?.type === "property_identifier" &&
            innerProp.text === "prototype"
          ) {
            names.add(innerObj.text);
          }
        }
      }
    }
    for (const child of n.children) visit(child);
  };
  visit(root);
  constructorNamesCache.set(root, names);
  return names;
}

function findRoot(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.parent) cur = cur.parent;
  return cur;
}

/**
 * Walk an assignment_expression's `right` chain (`a = b = c = fn`) and
 * return the innermost non-assignment value. Caller checks whether the
 * terminal is function-valued.
 */
function walkAssignmentChainToTerminalRhs(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.type === "assignment_expression") {
    const right = cur.childForFieldName("right");
    if (!right) return null;
    cur = right;
  }
  return cur;
}

/**
 * `expr` is the value being assigned — accept any expression form that
 * carries a callable: named/anonymous function_expression, arrow_function.
 * Bound expressions (`fn.bind(this)`) and class_expression are out of
 * scope for this slice — they're rarer and would need receiver typing
 * to be useful in the symbol table.
 */
function isFunctionValuedExpression(node: Parser.SyntaxNode): boolean {
  return node.type === "function_expression" || node.type === "arrow_function" || node.type === "generator_function";
}

/**
 * Collect symbols for every LHS in an assignment chain. For
 * `res.contentType = res.type = fn` we recurse: the outer LHS is
 * `res.contentType`, the inner assignment's LHS is `res.type` — both
 * emit. Pushes into `out` in source order.
 *
 * Pattern #4 anonymous skip: `module.exports = function () {}` (no
 * explicit name) produces no symbol — `module.exports` is not a useful
 * top-level identifier. Caller decides which "function name" form to
 * adopt; we emit the inner function's name if present, else nothing.
 */
function collectAssignmentTargets(node: Parser.SyntaxNode, terminalRhs: Parser.SyntaxNode, out: NamedSymbol[]): void {
  if (node.type !== "assignment_expression") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return;
  const lhsSymbol = lhsToNamedSymbol(left, terminalRhs);
  if (lhsSymbol) out.push(lhsSymbol);
  if (right?.type === "assignment_expression") {
    collectAssignmentTargets(right, terminalRhs, out);
  }
}

/**
 * Convert a single LHS node into a `NamedSymbol` per the symbolId
 * convention rules. `terminalRhs` is the function value at the end of
 * the assignment chain — used to pull the function's own name for the
 * `module.exports = function name() {}` case.
 *
 * Returns null when the LHS is not a recognised top-level target:
 *  - computed property access (`obj[key] = fn`) — out of scope (bead k05k)
 *  - deep chains beyond `prototype` (`A.B.prototype.C` is not idiomatic)
 *  - anonymous `module.exports = function () {}` (no name to attach)
 */
function lhsToNamedSymbol(left: Parser.SyntaxNode, terminalRhs: Parser.SyntaxNode): NamedSymbol | null {
  // Bare identifier on the left is just reassignment of an existing
  // binding; the original declarator (variable_declarator) already
  // emitted the symbol. Skip to avoid duplicates.
  if (left.type === "identifier") return null;
  if (left.type !== "member_expression") return null;

  const obj = left.childForFieldName("object");
  const prop = left.childForFieldName("property");
  if (!obj || !prop) return null;
  if (prop.type !== "property_identifier") return null; // skip `obj[expr] = fn`
  const propText = prop.text;

  // Pattern #2: `Foo.prototype.bar = fn` — obj is itself a
  // member_expression whose property is `prototype`. Emit `Foo#bar`.
  if (obj.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj && innerProp?.type === "property_identifier" && innerProp.text === "prototype") {
      // `Foo.prototype.bar` — Foo is the class. Use `#` directly in the
      // name since `collectSymbols` is at top-level scope when it sees
      // this assignment (composed === "") and joinSymbol just takes the
      // name verbatim. Embedding the `#` keeps the symbolId convention
      // consistent without requiring methodKind plumbing.
      const className = innerObj.text;
      return { name: `${className}${INSTANCE_METHOD_SEPARATOR}${propText}`, descendsInto: false };
    }
    // Deeper member chains (`a.b.c = fn`) are not idiomatic CommonJS
    // exports — skip to avoid polluting the symbol table.
    return null;
  }

  if (obj.type !== "identifier") return null;
  const objText = obj.text;

  // Pattern #3: `exports.foo = fn` → top-level `foo`.
  if (objText === "exports") {
    return { name: propText, descendsInto: false };
  }

  // Pattern #4: `module.exports = function name() {}` → top-level `name`.
  // The LHS is `module.exports`; we read the terminal function's name
  // (anonymous functions produce null, which the caller filters out).
  if (objText === "module" && propText === "exports") {
    const fnNameNode = terminalRhs.childForFieldName("name");
    if (!fnNameNode || fnNameNode.text.length === 0) return null;
    return { name: fnNameNode.text, descendsInto: false };
  }

  // Pattern #1: `obj.method = fn` → top-level `obj.method`. Receiver +
  // member rendered with `.` per symbolid-convention.md (module-method
  // shorthand on a non-class object).
  return { name: `${objText}.${propText}`, descendsInto: false };
}
