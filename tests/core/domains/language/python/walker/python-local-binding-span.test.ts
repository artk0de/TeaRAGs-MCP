/**
 * `LocalBinding.endLine` — the last line of the STATEMENT that establishes a
 * binding (bd tea-rags-mcp-w205u, E4.6a).
 *
 * netbox writes `layout = layout.Layout(\n    layout.Row(\n …))` as a class-body
 * attribute in eleven view files. Python evaluates the right-hand side before it
 * rebinds the name, so on EVERY line of that statement `layout` still denotes
 * the module `from netbox.ui import layout` bound — not the class being built.
 * `pythonBindingInForceAt` could only ask "is this the binding's own line",
 * which covers the first line and none of the rest, so the inner receivers were
 * typed as `Layout` and 50 rows fell out. The extent has to be a fact the
 * walker records; nothing downstream can reconstruct it from a line number.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

/** One chunk covering the whole file — the span is a per-statement fact, not a per-chunk one. */
function bindingsOf(src: string): Record<string, LocalBinding[]> | undefined {
  const tree = parse(src);
  const out = extractFromPythonFile({
    tree,
    code: src,
    relPath: "app/views.py",
    language: "python",
    chunks: [{ symbolId: "View", startLine: 1, endLine: 1000, scope: [] }],
  });
  return out.chunks[0].localBindings;
}

describe("extractFromPythonFile — the span of a local binding", () => {
  it("spans a multi-line constructor right-hand side, netbox's shape", () => {
    const src = [
      "class DataFileView:",
      "    layout = layout.Layout(",
      "        layout.Row(",
      "            layout.Column(),",
      "        ),",
      "    )",
      "",
    ].join("\n");
    expect(bindingsOf(src)?.layout).toEqual([{ line: 2, type: "layout.Layout", endLine: 6 }]);
  });

  it("collapses to the binding's own line for a single-line constructor", () => {
    expect(bindingsOf("def run():\n    y = Foo()\n")?.y).toEqual([{ line: 2, type: "Foo", endLine: 2 }]);
  });

  it("records the span for an ANNOTATED binding too", () => {
    // Emitted on every assignment branch, so no consumer has to reason about
    // which one produced the entry.
    expect(bindingsOf("def run():\n    z: Foo = make()\n")?.z).toEqual([{ line: 2, type: "Foo", endLine: 2 }]);
  });

  it("spans a multi-line ANNOTATED right-hand side", () => {
    const src = ["def run():", "    z: Foo = build(", "        1,", "    )", ""].join("\n");
    expect(bindingsOf(src)?.z).toEqual([{ line: 2, type: "Foo", endLine: 4 }]);
  });

  it("leaves a `def` parameter hint without a span — a parameter is not a shadowing statement", () => {
    const src = ["def run(req: Req):", "    return req", ""].join("\n");
    expect(bindingsOf(src)?.req).toEqual([{ line: 1, type: "Req" }]);
  });
});
