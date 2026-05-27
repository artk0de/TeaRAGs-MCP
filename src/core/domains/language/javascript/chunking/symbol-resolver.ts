/**
 * JavaScript symbol resolver for assignment_expression / lexical_declaration
 * shapes that carry a function value. Relocated from
 * `domains/ingest/pipeline/chunker/hooks/javascript/symbol-resolver.ts` into the
 * native JavaScript language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Returns the symbolId the chunk should emit for the node — matching the
 * codegraph `jsNameOf` output (in `../walker/name-of.ts`) for the same physical
 * AST node so the Qdrant payload symbolId and cg_symbols.symbol_id agree.
 *
 * MUST stay in sync with `../walker/name-of.ts:jsNameOf` / `lhsToNamedSymbol`.
 * See `.claude/rules/symbolid-convention.md`.
 *
 * For alias chains (`a = b = fn`) the chunker emits the OUTERMOST LHS as
 * the primary symbolId — chunks are 1:1 with AST nodes, so only one
 * symbolId per chunk is meaningful. Codegraph emits both via array
 * return; the chunker takes the first.
 *
 * The three exported entry points (`extractJsForEachDispatchSymbols`,
 * `extractJsAssignmentSymbol`, `extractJsNestedDefinePropertyThisSymbols`) are
 * composed into the engine-facing `chunkSymbols` capability by `chunk-symbols.ts`.
 *
 * bd tea-rags-mcp-kfzx
 */
import type Parser from "tree-sitter";

import { INSTANCE_METHOD_SEPARATOR } from "../../../../infra/symbolid/index.js";

function walkAssignmentChainToTerminalRhs(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.type === "assignment_expression") {
    const right = cur.childForFieldName("right");
    if (!right) return null;
    cur = right;
  }
  return cur;
}

function isFunctionValuedExpression(node: Parser.SyntaxNode): boolean {
  return node.type === "function_expression" || node.type === "arrow_function" || node.type === "generator_function";
}

/**
 * Convert a single LHS node into a symbolId per the convention rules.
 * Returns null for shapes the codegraph also skips
 * (computed property access, deep member chains beyond `prototype`,
 * anonymous `module.exports = function () {}`).
 */
function lhsToSymbolId(left: Parser.SyntaxNode, terminalRhs: Parser.SyntaxNode): string | null {
  // Bare identifier reassignment is handled by the original declarator —
  // skip to avoid duplicates (name-of.ts:lhsToNamedSymbol also returns
  // null here).
  if (left.type === "identifier") return null;
  if (left.type !== "member_expression") return null;

  const obj = left.childForFieldName("object");
  const prop = left.childForFieldName("property");
  if (!obj || !prop) return null;
  if (prop.type !== "property_identifier") return null;
  const propText = prop.text;

  // Pattern #2: `Foo.prototype.bar = fn` → `Foo#bar` (instance separator).
  if (obj.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj && innerProp?.type === "property_identifier" && innerProp.text === "prototype") {
      return `${innerObj.text}${INSTANCE_METHOD_SEPARATOR}${propText}`;
    }
    // Deeper chains are not idiomatic — skip.
    return null;
  }

  if (obj.type !== "identifier") return null;
  const objText = obj.text;

  // Pattern #3: `exports.foo = fn` → `foo` (top-level).
  if (objText === "exports") {
    return propText;
  }

  // Pattern #4: `module.exports = function name() {}` → terminal function's name.
  if (objText === "module" && propText === "exports") {
    const fnNameNode = terminalRhs.childForFieldName("name");
    if (!fnNameNode || fnNameNode.text.length === 0) return null;
    return fnNameNode.text;
  }

  // Pattern #1: `obj.method = fn` → `obj.method`.
  return `${objText}.${propText}`;
}

export interface JsAssignmentSymbol {
  /** Symbol id emitted to chunk metadata. Mirrors codegraph `jsNameOf`. */
  symbolId: string;
  /** Display name — same string as symbolId for these shapes. */
  name: string;
}

/**
 * Walk a top-level `expression_statement` (already identified as an
 * `<outer-receiver>.<member> = function () { ... }` assignment) looking
 * for any nested `Object.defineProperty(this, '<name>', { get: fn })` /
 * `defineGetter(this, '<name>', fn)` call inside the assigned function
 * body. Return one JsAssignmentSymbol per resolved nested getter — the
 * `this` receiver is rebound to the outer assignment's LHS receiver, so
 * `app.init = function() { Object.defineProperty(this, 'router', …); }`
 * yields `app.router` (NOT `app.init.this.router`).
 *
 * Returns empty array when the node is not such an assignment or no
 * nested getter installs were found. bd tea-rags-mcp-d1f8 this-resolve.
 *
 * MUST stay in sync with name-of.ts:resolveEnclosingThisReceiver +
 * name-of.ts:jsGetterHelperEmission `absolute: true` emission.
 */
export function extractJsNestedDefinePropertyThisSymbols(node: Parser.SyntaxNode): JsAssignmentSymbol[] {
  if (node.type !== "expression_statement") return [];
  // The top-level expression must be `<receiver>.<member> = function () {}`.
  // Find the assignment_expression and its function-valued RHS.
  let assign: Parser.SyntaxNode | null = null;
  for (const child of node.children) {
    if (child.type === "assignment_expression") {
      assign = child;
      break;
    }
  }
  if (!assign) return [];
  const terminal = walkAssignmentChainToTerminalRhs(assign);
  if (!terminal || !isFunctionValuedExpression(terminal)) return [];
  if (terminal.type !== "function_expression" && terminal.type !== "function_declaration") return [];

  // The receiver text of the outer LHS — `app` in `app.init = function …`.
  const left = assign.childForFieldName("left");
  if (left?.type !== "member_expression") return [];
  const outerObj = left.childForFieldName("object");
  if (!outerObj) return [];
  const receiverText = receiverDisplayText(outerObj);
  if (!receiverText) return [];

  const body = terminal.childForFieldName("body");
  if (!body) return [];

  // Walk the function body collecting `Object.defineProperty(this, '<n>', …)`
  // and `defineGetter(this, '<n>', fn)` calls. Skip any call nested inside
  // a deeper non-arrow function — `this` would rebind there.
  const out: JsAssignmentSymbol[] = [];
  const visit = (n: Parser.SyntaxNode): void => {
    if (
      n !== terminal &&
      (n.type === "function_expression" ||
        n.type === "function_declaration" ||
        n.type === "generator_function" ||
        n.type === "generator_function_declaration")
    ) {
      // Deeper non-arrow function — `this` rebinds; don't descend.
      return;
    }
    if (n.type === "call_expression") {
      const id = nestedGetterInstallThisName(n);
      if (id) {
        out.push({ symbolId: `${receiverText}.${id}`, name: `${receiverText}.${id}` });
      }
    }
    for (const child of n.children) visit(child);
  };
  visit(body);
  return out;
}

/**
 * If `call` is `Object.defineProperty(this, '<name>', { get|set: fn, … })`
 * or `defineGetter(this, '<name>', fn)`, return `<name>`. Otherwise null.
 */
function nestedGetterInstallThisName(call: Parser.SyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (!callee || !args) return null;
  const namedArgs = args.namedChildren;
  if (namedArgs.length < 3) return null;
  const receiver = namedArgs[0];
  if (receiver?.type !== "this") return null;
  const nameArg = namedArgs[1];
  if (!nameArg) return null;
  const propName = readStringLiteral(nameArg);
  if (!propName) return null;

  if (callee.type === "member_expression") {
    const obj = callee.childForFieldName("object");
    const prop = callee.childForFieldName("property");
    if (
      obj?.type === "identifier" &&
      obj.text === "Object" &&
      prop?.type === "property_identifier" &&
      prop.text === "defineProperty"
    ) {
      const descriptor = namedArgs[2];
      if (descriptor?.type !== "object") return null;
      if (!objectHasGetterPair(descriptor)) return null;
      return propName;
    }
  }
  if (callee.type === "identifier" && callee.text === "defineGetter") {
    const fnArg = namedArgs[2];
    if (!fnArg || !isFunctionValuedExpression(fnArg)) return null;
    return propName;
  }
  return null;
}

/**
 * The npm `methods` package's HTTP-verb list. Pinned to the historic
 * 9 verbs express has always used. MUST stay in sync with
 * `name-of.ts:HTTP_VERBS` (bd tea-rags-mcp-z95o).
 */
const HTTP_VERBS = ["get", "post", "put", "delete", "head", "options", "patch", "connect", "trace"] as const;

/**
 * Inspect a JS top-level chunkable node for the
 * `<methods>.forEach(method => obj[method] = fn)` HTTP-verb dispatch
 * pattern (bd tea-rags-mcp-z95o). Returns one JsAssignmentSymbol per
 * known HTTP verb when the pattern matches AND at least one HTTP-verb
 * signal holds (require('methods'), local util import, OR string-literal
 * HTTP-verb comparison in the body — the strongest signal, catches
 * express directly). Otherwise null.
 *
 * MUST stay in sync with `name-of.ts:jsForEachDispatchEmission`.
 */
export function extractJsForEachDispatchSymbols(node: Parser.SyntaxNode): JsAssignmentSymbol[] | null {
  if (node.type !== "expression_statement") return null;
  let call: Parser.SyntaxNode | null = null;
  for (const child of node.children) {
    if (child.type === "call_expression") {
      call = child;
      break;
    }
  }
  if (!call) return null;

  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (!callee || !args) return null;
  if (callee.type !== "member_expression") return null;
  const recv = callee.childForFieldName("object");
  const method = callee.childForFieldName("property");
  if (recv?.type !== "identifier") return null;
  if (method?.type !== "property_identifier" || method.text !== "forEach") return null;

  const fnArg = args.namedChildren[0];
  if (!fnArg || !isFunctionValuedExpression(fnArg)) return null;
  const params = fnArg.childForFieldName("parameters");
  if (!params) return null;
  const paramIds = params.namedChildren.filter((c) => c.type === "identifier");
  if (paramIds.length !== 1) return null;
  const paramName = paramIds[0].text;

  const body = fnArg.childForFieldName("body");
  if (!body) return null;

  // Inside the body, find the subscript assignment that anchors `<obj>`.
  const dispatchLhs: { node: Parser.SyntaxNode | null } = { node: null };
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (dispatchLhs.node) return true;
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left?.type === "subscript_expression" && right && isFunctionValuedExpression(right)) {
        const idx = left.childForFieldName("index");
        if (idx?.type === "identifier" && idx.text === paramName) {
          dispatchLhs.node = left;
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
  if (!dispatchLhs.node) return null;
  const objNode = dispatchLhs.node.childForFieldName("object");
  if (objNode?.type !== "identifier") return null;
  const objText = objNode.text;

  // Walk to the program root for require/import lookups.
  let root: Parser.SyntaxNode | null = node;
  while (root?.parent) root = root.parent;
  if (!root) return null;

  // Apply HTTP-verb signal heuristics — any one is sufficient.
  if (!hasHttpVerbDispatchSignal(root, recv.text, body, paramName)) return null;

  return HTTP_VERBS.map((verb) => ({ symbolId: `${objText}.${verb}`, name: `${objText}.${verb}` }));
}

/**
 * Return true if the file (rooted at `root`) carries any signal that the
 * forEach receiver `recvName` iterates HTTP verbs. Mirrors
 * `name-of.ts:hasHttpVerbDispatchSignal`.
 *
 *   1. Body contains string-literal HTTP-verb comparisons like
 *      `<paramName> === 'get'` — STRONGEST signal.
 *   2. `recvName === "methods"` AND a sibling require imports
 *      the npm `methods` package.
 *   3. `recvName === "methods"` AND a sibling require imports a local
 *      utility module whose path contains `util`.
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
 * Walk `root` to find a `variable_declarator` of shape
 *   <recvName> = require('<source>')
 * and return the source string. Mirrors name-of.ts:findRequireSource.
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
          if (stringArg?.type === "string") {
            const frag = stringArg.namedChildren.find((c) => c.type === "string_fragment");
            if (frag) {
              found = frag.text;
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
 * Inspect a JS top-level chunkable node and return its symbol if the node
 * matches one of the assignment_expression / lexical_declaration shapes
 * the codegraph also recognises. Returns null for any other node — caller
 * should fall back to the default name extraction.
 */
export function extractJsAssignmentSymbol(node: Parser.SyntaxNode): JsAssignmentSymbol | null {
  // Pattern #5: `const|let|var Foo = function () {}` / arrow.
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const child of node.children) {
      if (child.type !== "variable_declarator") continue;
      const nameNode = child.childForFieldName("name");
      const valueNode = child.childForFieldName("value");
      if (!nameNode || !valueNode) continue;
      if (nameNode.type !== "identifier") continue;
      if (!isFunctionValuedExpression(valueNode)) continue;
      return { symbolId: nameNode.text, name: nameNode.text };
    }
    return null;
  }

  // Patterns #1-#4, #6: `<lhs> = <function-valued rhs>` wrapped in expression_statement.
  // Pattern #7 (bd tea-rags-mcp-d1f8): JS getter helpers — Object.defineProperty
  // and the project-specific `defineGetter` helper.
  if (node.type === "expression_statement") {
    let assign: Parser.SyntaxNode | null = null;
    let call: Parser.SyntaxNode | null = null;
    for (const child of node.children) {
      if (child.type === "assignment_expression") {
        assign = child;
        break;
      }
      if (child.type === "call_expression") {
        call = child;
      }
    }
    if (assign) {
      const terminal = walkAssignmentChainToTerminalRhs(assign);
      if (!terminal || !isFunctionValuedExpression(terminal)) return null;

      // Outermost LHS — chunks are 1:1 with AST nodes so we emit one symbolId
      // even for alias chains. Codegraph emits both via array; the chunker's
      // primary is the first.
      const left = assign.childForFieldName("left");
      if (!left) return null;
      const symbolId = lhsToSymbolId(left, terminal);
      if (!symbolId) return null;
      return { symbolId, name: symbolId };
    }
    if (call) {
      const getterId = getterHelperSymbolId(call);
      if (getterId) return { symbolId: getterId, name: getterId };
    }
  }

  return null;
}

/**
 * Recognise getter-install helpers (mirrors name-of.ts:jsGetterHelperEmission)
 * and return the installed symbolId.
 *
 *   Object.defineProperty(<obj>, '<name>', { get: fn, set: fn })  → `<obj>.<name>`
 *   defineGetter(<obj>, '<name>', fn)                              → `<obj>.<name>`
 *
 * MUST stay in sync with name-of.ts:jsGetterHelperEmission. See
 * `.claude/rules/symbolid-convention.md` and bd tea-rags-mcp-d1f8.
 */
function getterHelperSymbolId(call: Parser.SyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
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
      return `${receiverText}.${propName}`;
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
    return `${receiverText}.${propName}`;
  }

  return null;
}

/**
 * Render the receiver of a `defineProperty` / `defineGetter` call as the
 * text used in the emitted symbolId, with `this` resolution. Mirrors
 * `name-of.ts:resolveReceiverText`. bd tea-rags-mcp-d1f8 this-resolve.
 */
function resolveReceiverText(receiver: Parser.SyntaxNode): string | null {
  if (receiver.type !== "this") return receiverDisplayText(receiver);
  return resolveEnclosingThisReceiver(receiver);
}

/**
 * Walk `node.parent` upward looking for the outermost enclosing non-arrow
 * function-valued expression that is the RHS of an outer
 * `<receiver>.<member> = function … { … }` assignment. Return the
 * receiver text (e.g. `"app"`, `"exports.proto"`) when found, else null.
 * Mirrors `name-of.ts:resolveEnclosingThisReceiver`.
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
      const fn = cur;
      const fnParent = fn.parent;
      if (fnParent?.type === "assignment_expression") {
        const right = fnParent.childForFieldName("right");
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
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

function readStringLiteral(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const frag = node.namedChildren.find((c) => c.type === "string_fragment");
    return frag ? frag.text : null;
  }
  if (node.type === "template_string") {
    const hasInterp = node.namedChildren.some((c) => c.type === "template_substitution");
    if (hasInterp) return null;
    return node.text.replace(/^`|`$/g, "");
  }
  return null;
}

function receiverDisplayText(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "this") return "this";
  if (node.type === "member_expression") {
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
