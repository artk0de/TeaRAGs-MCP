/**
 * Rust inline-test recognition from AST attributes.
 *
 * Rust tests live beside product code: `#[cfg(test)]` items, `#![cfg(test)]`
 * modules and files, and functions carrying a test-family attribute. Every
 * predicate here reads attributes from the syntax tree — outer `attribute_item`
 * siblings preceding the item and `inner_attribute_item` children of a body —
 * never from source lines, so attributes sharing a line with the item, spanning
 * several lines, or followed by a comment are all read the same way. Children
 * are read by node type, not by field name, so a materialized tree answers
 * exactly like a native one.
 */

import type { AstNode } from "../../../contracts/types/ast.js";

/** Last `::` segment of an attribute path that marks a test-only function. */
const RUST_TEST_FUNCTION_ATTRIBUTES = new Set([
  "test",
  "rstest",
  "test_case",
  "bench",
  "quickcheck",
  "proptest",
  "wasm_bindgen_test",
]);

const COMMENT_NODE_TYPES = new Set(["line_comment", "block_comment"]);

/** Three-valued `cfg` truth: `undefined` = depends on a non-`test` predicate. */
type RustCfgTruth = boolean | undefined;

/** The `attribute` body of each outer attribute preceding `node`, nearest last. */
function outerAttributes(node: AstNode): AstNode[] {
  const attributes: AstNode[] = [];
  for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
    if (COMMENT_NODE_TYPES.has(sibling.type)) continue;
    if (sibling.type !== "attribute_item") break;
    const attribute = attributeOf(sibling);
    if (attribute) attributes.unshift(attribute);
  }
  return attributes;
}

/** The `attribute` body of each `inner_attribute_item` directly under `container`. */
function innerAttributes(container: AstNode): AstNode[] {
  return container.namedChildren
    .filter((child) => child.type === "inner_attribute_item")
    .map(attributeOf)
    .filter((attribute): attribute is AstNode => attribute !== null);
}

function attributeOf(item: AstNode): AstNode | null {
  return item.namedChildren.find((child) => child.type === "attribute") ?? null;
}

/** Last `::` segment of the attribute path: `tokio::test` → `test`. */
function attributeName(attribute: AstNode): string {
  const path = attribute.namedChildren[0];
  if (!path || path.type === "token_tree") return "";
  return path.text.split("::").at(-1)?.trim() ?? "";
}

/** True for `cfg(P)` whose predicate is definitely false outside the test build. */
function isTestOnlyCfgAttribute(attribute: AstNode): boolean {
  if (attributeName(attribute) !== "cfg") return false;
  const args = attribute.namedChildren.find((child) => child.type === "token_tree");
  if (!args) return false;
  const text = args.text.trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  return rustCfgIsTestOnly(text.slice(1, -1));
}

/** A `function_item` carrying a test-family attribute (`#[test]`, `#[tokio::test]`, `#[rstest]`, …). */
export function isRustTestFunctionNode(node: AstNode, _code: string): boolean {
  if (node.type !== "function_item") return false;
  return outerAttributes(node).some((attribute) => RUST_TEST_FUNCTION_ATTRIBUTES.has(attributeName(attribute)));
}

/**
 * True when the node and its whole subtree compile only in the test build: an
 * item under a test-only outer `cfg`, a module whose body opens with a
 * test-only inner `cfg`, or a test-family function.
 */
export function isInlineTestNode(node: AstNode, code: string): boolean {
  if (outerAttributes(node).some(isTestOnlyCfgAttribute)) return true;
  if (node.type === "mod_item") {
    const body = node.namedChildren.find((child) => child.type === "declaration_list");
    if (body && innerAttributes(body).some(isTestOnlyCfgAttribute)) return true;
  }
  return isRustTestFunctionNode(node, code);
}

/** The file root carries an inner `#![cfg(test)]` — the whole file is test-only. */
export function fileIsInlineTestOnly(root: AstNode, _code: string): boolean {
  return innerAttributes(root).some(isTestOnlyCfgAttribute);
}

/**
 * Evaluate a `cfg(...)` predicate (the text inside the parentheses) for a
 * product build: `test` is false, `not` / `all` / `any` combine in three-valued
 * logic, every other predicate is unknown. Test-only iff definitely false.
 * Unparseable text is not test-only.
 */
export function rustCfgIsTestOnly(predicateText: string): boolean {
  const parser = new RustCfgPredicateParser(predicateText);
  const truth = parser.parsePredicate();
  return parser.atEnd() && truth === false;
}

const CFG_TOKEN_PATTERN = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*")|([(),=]))/y;

/** Recursive-descent reader of the `cfg` predicate grammar over a token list. */
class RustCfgPredicateParser {
  private readonly tokens: string[] = [];
  private position = 0;
  private malformed = false;

  constructor(text: string) {
    // A failed sticky match resets `lastIndex` to 0, so the consumed end is tracked here.
    let consumed = 0;
    CFG_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CFG_TOKEN_PATTERN.exec(text)) !== null) {
      this.tokens.push(match[1] ?? match[2] ?? match[3]);
      consumed = CFG_TOKEN_PATTERN.lastIndex;
    }
    if (text.slice(consumed).trim().length > 0) this.malformed = true;
  }

  atEnd(): boolean {
    return !this.malformed && this.position === this.tokens.length;
  }

  parsePredicate(): RustCfgTruth {
    const name = this.tokens[this.position++];
    if (name === undefined || !/^[A-Za-z_]/.test(name)) {
      this.malformed = true;
      return undefined;
    }
    if (this.tokens[this.position] === "=") {
      this.position++;
      if (!this.tokens[this.position++]?.startsWith('"')) this.malformed = true;
      return undefined;
    }
    if (this.tokens[this.position] !== "(") return name === "test" ? false : undefined;
    this.position++;
    const operands = this.parseOperands();
    if (name === "all") return conjunction(operands);
    if (name === "any") return disjunction(operands);
    if (name === "not" && operands.length === 1) return operands[0] === undefined ? undefined : !operands[0];
    return undefined;
  }

  private parseOperands(): RustCfgTruth[] {
    const operands: RustCfgTruth[] = [];
    while (!this.malformed && this.tokens[this.position] !== ")") {
      if (this.position >= this.tokens.length) {
        this.malformed = true;
        break;
      }
      operands.push(this.parsePredicate());
      if (this.tokens[this.position] === ",") this.position++;
      else if (this.tokens[this.position] !== ")") this.malformed = true;
    }
    this.position++;
    return operands;
  }
}

function conjunction(operands: RustCfgTruth[]): RustCfgTruth {
  if (operands.includes(false)) return false;
  return operands.includes(undefined) ? undefined : true;
}

function disjunction(operands: RustCfgTruth[]): RustCfgTruth {
  if (operands.includes(true)) return true;
  return operands.includes(undefined) ? undefined : false;
}
