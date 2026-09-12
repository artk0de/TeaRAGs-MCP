/**
 * The traversal DRIVER the Python file-level collectors share
 * (bd tea-rags-mcp-1v12o.2.7, E6.2).
 *
 * `extractFromPythonFile` used to walk the same materialized tree once per
 * collector — fourteen full descents of every node in the file. `walkOnce`
 * descends once and hands each node to every visitor, which is only
 * output-preserving if two things hold, and both are asserted here: each
 * visitor still sees the SAME pre-order sequence it saw when it owned the walk,
 * and at a given node the visitors fire in list order, so a collector that
 * reads what an earlier one wrote keeps reading it in the same order.
 *
 * `walkPythonClassScopes` is the same claim for the scope-tracking half: the
 * three class-keyed collectors agreed on their bookkeeping node for node, so
 * the driver has to reproduce the scope, the enclosing class FQ, and the
 * container-name signal each of them branched on.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import { walkOnce, walkPythonClassScopes } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const SOURCE = [
  "import os",
  "from .models import Account",
  "",
  "class Service(Base, Mixin):",
  "    objects = Manager()",
  "",
  "    def __init__(self):",
  "        self.repo = AccountRepository()",
  "        self.cache = build_cache()",
  "",
  "    class Inner:",
  "        def run(self):",
  "            return os.getcwd()",
  "",
  "def factory():",
  "    class Local(Service):",
  "        pass",
  "    return Local",
].join("\n");

function materialize(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return materializeTree(parser.parse(src).rootNode, src);
}

/** The sequential descent each collector used to own, kept here as the oracle. */
function referencePreOrder(node: AstNode, out: AstNode[]): AstNode[] {
  out.push(node);
  for (const child of node.children) referencePreOrder(child, out);
  return out;
}

describe("walkOnce — one descent, N visitors", () => {
  it("gives every visitor the pre-order a sequential walk gave it", () => {
    const root = materialize(SOURCE);
    const expected = referencePreOrder(root, []);
    const seen: AstNode[][] = [[], [], []];

    walkOnce(root, [(n) => seen[0].push(n), (n) => seen[1].push(n), (n) => seen[2].push(n)]);

    expect(expected.length).toBeGreaterThan(50);
    for (const perVisitor of seen) expect(perVisitor).toEqual(expected);
  });

  it("fires the visitors in list order at each node", () => {
    const root = materialize(SOURCE);
    const nodeCount = referencePreOrder(root, []).length;
    const log: number[] = [];

    walkOnce(root, [() => log.push(0), () => log.push(1), () => log.push(2)]);

    expect(log.length).toBe(nodeCount * 3);
    const expected: number[] = [];
    for (let i = 0; i < nodeCount; i++) expected.push(0, 1, 2);
    expect(log).toEqual(expected);
  });

  it("visits the root and descends an empty visitor list without touching the tree", () => {
    const root = materialize(SOURCE);
    const first: AstNode[] = [];

    walkOnce(root, [(n) => first.push(n)]);
    expect(first[0]).toBe(root);
    expect(() => {
      walkOnce(root, []);
    }).not.toThrow();
  });
});

describe("walkPythonClassScopes — one scoped descent, N visitors", () => {
  it("reports the enclosing scope, class FQ and container scope each collector branched on", () => {
    const root = materialize(SOURCE);
    const containers: string[] = [];
    const selfAssignments: string[] = [];

    walkPythonClassScopes(root, [
      (node, scope, _classFq, containerScope) => {
        if (containerScope === undefined) return;
        containers.push(`${node.type}|${scope.join(".")}|${containerScope.join(".")}`);
      },
      (node, _scope, classFq, containerScope) => {
        if (containerScope !== undefined || classFq === undefined) return;
        if (node.type !== "assignment") return;
        selfAssignments.push(`${classFq}|${node.text.split(" ")[0]}`);
      },
    ]);

    expect(containers).toEqual([
      "class_definition||Service",
      "function_definition|Service|Service.__init__",
      "class_definition|Service|Service.Inner",
      "function_definition|Service.Inner|Service.Inner.run",
      "function_definition||factory",
      "class_definition|factory|factory.Local",
    ]);
    // A `def` does not open a class, so `__init__`'s assignments still key on
    // `Service` — and a class declared inside a `def` keys `factory.Local`.
    expect(selfAssignments).toEqual(["Service|objects", "Service|self.repo", "Service|self.cache"]);
  });

  it("hands both visitors the same node sequence", () => {
    const root = materialize(SOURCE);
    const seen: AstNode[][] = [[], []];

    walkPythonClassScopes(root, [(n) => seen[0].push(n), (n) => seen[1].push(n)]);

    expect(seen[0].length).toBeGreaterThan(30);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0][0]).toBe(root);
  });
});
