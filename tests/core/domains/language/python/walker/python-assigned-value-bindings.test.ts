/**
 * Assigned-value bindings, walker half (bd tea-rags-mcp-m99j1.1.91): a plain
 * `name = <attribute read>` or `name = <other name>` records the VALUE
 * expression as an `assignedValue` derived binding, so the resolver can type
 * the local exactly instead of leaving it to the dynamic fan — which the
 * assigned-local gate declines (`opts = self.model._meta`,
 * `app = ctx.app`). The binding speaks only until the def rebinds the name.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function bindingsOf(src: string): Record<string, LocalBinding[]> {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const lines = src.split("\n").length;
  const extraction = extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/admin.py",
    language: "python",
    chunks: [{ symbolId: "Admin#run", scope: ["Admin"], startLine: 1, endLine: lines }],
  });
  return extraction.chunks[0].localBindings ?? {};
}

describe("Python walker — assigned-value bindings (m99j1.1.91)", () => {
  it("`name = <attribute read>` carries the read expression", () => {
    const src = [
      "class Admin:",
      "    def run(self):",
      "        opts = self.model._meta",
      "        opts.get_field('x')",
    ];
    expect(bindingsOf(src.join("\n")).opts).toEqual([
      { line: 3, type: "", valueKind: "assignedValue", sourceExpression: "self.model._meta", endLine: 3 },
    ]);
  });

  it("`name = <other name>` carries that name", () => {
    const src = ["class Admin:", "    def run(self, request):", "        req = request", "        req.get()"];
    expect(bindingsOf(src.join("\n")).req).toEqual([
      { line: 3, type: "", valueKind: "assignedValue", sourceExpression: "request", endLine: 3 },
    ]);
  });

  it("records nothing for a call, a subscript, a literal or an annotated assignment", () => {
    const src = [
      "class Admin:",
      "    def run(self):",
      "        a = self.build()",
      "        b = self.table[0]",
      "        c = None",
      "        d: Options = self.model._meta",
      "        e = self.model._meta if self.model else None",
    ];
    const bindings = bindingsOf(src.join("\n"));
    expect(bindings.a).toBeUndefined();
    expect(bindings.b).toBeUndefined();
    expect(bindings.c).toBeUndefined();
    expect(bindings.d?.map((binding) => binding.valueKind)).toEqual([undefined]);
    expect(bindings.e).toBeUndefined();
  });

  it("stops speaking at the line the def rebinds the name, by any binding form", () => {
    const src = [
      "class Admin:",
      "    def run(self, rows):",
      "        node = self.root",
      "        node.visit()",
      "        node = rows[0]",
      "        node.visit()",
      "        field = self.field",
      "        for field in rows:",
      "            field.clean()",
    ];
    const bindings = bindingsOf(src.join("\n"));
    expect(bindings.node).toEqual([
      { line: 3, type: "", valueKind: "assignedValue", sourceExpression: "self.root", endLine: 3, scopeEndLine: 5 },
    ]);
    expect(bindings.field?.[0]).toEqual({
      line: 7,
      type: "",
      valueKind: "assignedValue",
      sourceExpression: "self.field",
      endLine: 7,
      scopeEndLine: 8,
    });
  });

  it("a rebinding inside a NESTED def or lambda does not cut the outer local", () => {
    const src = [
      "class Admin:",
      "    def run(self):",
      "        app = self.app",
      "        def inner():",
      "            app = None",
      "            return app",
      "        app.render()",
    ];
    expect(bindingsOf(src.join("\n")).app).toEqual([
      { line: 3, type: "", valueKind: "assignedValue", sourceExpression: "self.app", endLine: 3 },
    ]);
  });
});

describe("Python walker — a DECLARED local keeps its declaration (m99j1.1.91)", () => {
  it("records nothing for a name the def annotates — as a parameter or a PEP 526 target", () => {
    const src = [
      "class Admin:",
      "    def run(self, behavior: Behavior | None = None):",
      "        member: Member | None = None",
      "        if behavior is None:",
      "            behavior = self.org.behavior",
      "        member = self.subject.member",
      "        behavior.is_immediate()",
      "        member.save()",
    ];
    const bindings = bindingsOf(src.join("\n"));
    expect(bindings.behavior?.some((binding) => binding.valueKind === "assignedValue") ?? false).toBe(false);
    expect(bindings.member?.some((binding) => binding.valueKind === "assignedValue") ?? false).toBe(false);
  });
});
