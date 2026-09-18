/**
 * A materialized node allocates its field map only when it has a field child
 * (bd tea-rags-mcp-1v12o.2.4, E6.1 FIX C).
 *
 * `MaterializedNode` cost roughly 350 B: the node, two child arrays, two
 * position objects, and an eager `new Map()` that stayed EMPTY on most nodes —
 * identifiers, operators, punctuation, every literal. On Python's netbox that is
 * a map per node across millions of nodes. Both halves below are the gate: field
 * lookup must still answer exactly what the native tree answers, and a
 * field-less node must not construct a Map.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../src/core/contracts/types/ast.js";
import { materializeTree } from "../../../src/core/infra/materialize.js";

/** Enough grammar shapes that most node types in the tree carry no field at all. */
const FIXTURE = [
  "from __future__ import annotations",
  "import os.path as p",
  "",
  "class Service(Base, Mixin):",
  "    registry: dict[str, int] = {}",
  "",
  "    def handle(self, request: HttpRequest, flag: bool = False) -> Response:",
  "        repo = AccountRepository()",
  "        total = 1 + 2 * 3 - len(request.items)",
  "        if total < 10 < 100:",
  "            return repo.save(total, flag=flag)",
  "        for item in request.items:",
  "            yield item.name",
  "        return None",
  "",
].join("\n");

function parseNative(src: string): Parser.SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src).rootNode;
}

describe("materializeTree — the field map is lazy", () => {
  it("answers every field lookup exactly as the native tree does", () => {
    const native = parseNative(FIXTURE);
    const root = materializeTree(native, FIXTURE);

    let checkedFields = 0;
    const compare = (nativeNode: Parser.SyntaxNode, node: AstNode): void => {
      const fields = new Set<string>();
      for (let i = 0; i < nativeNode.childCount; i++) {
        const name = nativeNode.fieldNameForChild(i);
        if (name) fields.add(name);
      }
      for (const field of fields) {
        checkedFields++;
        expect(node.childForFieldName(field)?.startIndex).toBe(nativeNode.childForFieldName(field)?.startIndex);
      }
      // A field the node does not carry stays null, map or no map.
      expect(node.childForFieldName("definitely_not_a_field")).toBeNull();
      for (let i = 0; i < nativeNode.childCount; i++) {
        const child = nativeNode.child(i);
        const materializedChild = node.child(i);
        if (child !== null && materializedChild !== null) compare(child, materializedChild);
      }
    };
    compare(native, root);
    expect(checkedFields).toBeGreaterThan(40);
  });

  it("constructs one Map per node that HAS a field, not one per node", () => {
    const native = parseNative(FIXTURE);

    let totalNodes = 0;
    let nodesWithFields = 0;
    const census = (nativeNode: Parser.SyntaxNode): void => {
      totalNodes++;
      let hasField = false;
      for (let i = 0; i < nativeNode.childCount; i++) {
        if (nativeNode.fieldNameForChild(i)) hasField = true;
        const child = nativeNode.child(i);
        if (child !== null) census(child);
      }
      if (hasField) nodesWithFields++;
    };
    census(native);
    expect(nodesWithFields).toBeLessThan(totalNodes / 2);

    const RealMap = globalThis.Map;
    let constructed = 0;
    class CountingMap<K, V> extends RealMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        constructed++;
      }
    }
    globalThis.Map = CountingMap as unknown as MapConstructor;
    try {
      materializeTree(native, FIXTURE);
    } finally {
      globalThis.Map = RealMap;
    }
    expect(constructed).toBe(nodesWithFields);
  });
});
