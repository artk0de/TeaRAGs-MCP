/**
 * Python `nameOf` — maps a tree-sitter node to its `NamedSymbol` descriptor
 * for codegraph symbol extraction. Relocated from
 * `domains/trajectory/codegraph/symbols/provider.ts` (`pyNameOf`) into the
 * native Python language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6, following the ruby + typescript + javascript
 * verticals). The relocation was behaviour-preserving; the one divergence since
 * is the `@overload` yield below (bd tea-rags-mcp-0qyze).
 *
 * `function_definition` / `class_definition` route through `classifyMethod`
 * (in `infra/symbolid`) so the chunker and codegraph agree on the separator for
 * the same physical AST node (`.claude/rules/symbolid-convention.md`): a method
 * decorated with `@classmethod` / `@staticmethod` is class-level (`.`), an
 * undecorated method inside a class is instance-level (`#`).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { NamedSymbol } from "../../../../contracts/types/codegraph.js";
import { classifyMethod } from "../../../../infra/symbolid/index.js";

function methodKindFromClassify(node: AstNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

/** `@overload` / `@typing.overload` / `@t.overload` — a dotted path ending in `overload`. */
const OVERLOAD_DECORATOR = /^@\s*(?:[A-Za-z_]\w*\s*\.\s*)*overload$/;

/** The `function_definition` a `decorated_definition` wraps, or the node itself. */
function pyUndecorated(node: AstNode): AstNode {
  return node.type === "decorated_definition" ? (node.childForFieldName("definition") ?? node) : node;
}

function pyIsOverloadStub(fn: AstNode): boolean {
  const { parent } = fn;
  if (parent?.type !== "decorated_definition") return false;
  return parent.children.some((c) => c.type === "decorator" && OVERLOAD_DECORATOR.test(c.text.trim()));
}

/**
 * Does an `@overload` stub have an implementation to yield its symbolId to (bd
 * tea-rags-mcp-0qyze)?
 *
 * `collectSymbols` dedups by symbolId keeping the FIRST occurrence, so without
 * this the leading stub — a signature with a `...` body — won `Cls#m` and the
 * implementation got no symbol range at all. Every call in the implementation
 * body then fell through to the enclosing CLASS chunk, whose `scope` is `[]`,
 * which `pythonEnclosingClass` reads as "no enclosing class": 112 of polar's
 * `self.client.build_request()` / `send_request()` sites, across 22 generated
 * SDK service files, all of them inside the def that follows an overload group.
 *
 * The yield is conditional because a group with NO implementation is a real
 * declaration — a `typing.Protocol` or ABC body — and dropping the stub there
 * would delete the symbol instead of relocating it. Only a LATER sibling
 * declaring the same name WITHOUT an `@overload` decorator counts, which is
 * exactly where PEP 484 puts the implementation.
 */
function pyOverloadIsImplementedLater(fn: AstNode): boolean {
  const name = fn.childForFieldName("name")?.text;
  const decorated = fn.parent;
  const container = decorated?.parent;
  if (name === undefined || !decorated || !container) return false;
  const after = decorated.startPosition.row;
  for (const sibling of container.children) {
    if (sibling.startPosition.row <= after) continue;
    const candidate = pyUndecorated(sibling);
    if (candidate.type !== "function_definition") continue;
    if (candidate.childForFieldName("name")?.text !== name) continue;
    if (!pyIsOverloadStub(candidate)) return true;
  }
  return false;
}

export function pyNameOf(node: AstNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    if (pyIsOverloadStub(node) && pyOverloadIsImplementedLater(node)) return null;
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "class_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}
