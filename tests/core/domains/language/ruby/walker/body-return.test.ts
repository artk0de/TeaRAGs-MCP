/**
 * The port seam between Ruby and the kernel's return-inference engine (bd
 * tea-rags-mcp-m99j1.1.61). The flat (`collectRubyBodyReturnTypes`) and
 * owner-keyed (`collectRubyScopedBodyReturnTypes`) channels used to run their own
 * tail → `constInstanceType` engine; they now ask `inferReturnTypeName` through
 * the MEMBER port set pinned here. The member ports are deliberately narrower
 * than the service-entry set in `body-last-expr.ts`: no binding indirection, no
 * `.freeze`/`.tap` passthrough, no coercion ternary — the channels never had
 * those, and the lift is an identity.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import { FULL_RUBY_CATALOGUE } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";
import {
  inferRubyMemberReturnType,
  rubyBodyTailExpression,
  rubyMemberReturnPorts,
} from "../../../../../../src/core/domains/language/ruby/walker/body-return.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(`${src}\n`).rootNode;
}

/** The first `def` in the tree. */
function firstDef(root: AstNode): AstNode {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === "method" || n.type === "singleton_method") return n;
    stack.push(...n.children);
  }
  throw new Error("no def");
}

/** The class body enclosing the first def. */
function firstClassBody(root: AstNode): AstNode {
  const klass = root.namedChildren.find((n) => n.type === "class");
  if (!klass) throw new Error("no class");
  return klass.childForFieldName("body") ?? klass;
}

describe("rubyBodyTailExpression", () => {
  it("is the body's last statement", () => {
    const def = firstDef(parse(["def build", "  prepare", "  Widget.new", "end"].join("\n")));
    expect(rubyBodyTailExpression(def)?.text).toBe("Widget.new");
  });

  it("unwraps an explicit `return EXPR`", () => {
    const def = firstDef(parse(["def build", "  return Widget.new", "end"].join("\n")));
    expect(rubyBodyTailExpression(def)?.text).toBe("Widget.new");
  });

  it("skips `rescue` / `ensure` tails so the normal-path value is seen", () => {
    const def = firstDef(
      parse(["def build", "  Widget.new", "rescue StandardError", "  nil", "ensure", "  cleanup", "end"].join("\n")),
    );
    expect(rubyBodyTailExpression(def)?.text).toBe("Widget.new");
  });

  it("is null for an empty body and for a bare `return`", () => {
    expect(rubyBodyTailExpression(firstDef(parse(["def build", "end"].join("\n"))))).toBeNull();
    expect(rubyBodyTailExpression(firstDef(parse(["def build", "  return", "end"].join("\n"))))).toBeNull();
  });
});

describe("rubyMemberReturnPorts", () => {
  const ports = rubyMemberReturnPorts(FULL_RUBY_CATALOGUE);

  it("hands the kernel exactly one terminal — the body tail — or none", () => {
    const def = firstDef(parse(["def build", "  Widget.new", "end"].join("\n")));
    const site = { method: def, classBody: null };
    expect(ports.terminalExpressions(def, site).map((n) => n.text)).toEqual(["Widget.new"]);
    const empty = firstDef(parse(["def build", "end"].join("\n")));
    expect(ports.terminalExpressions(empty, { method: empty, classBody: null })).toEqual([]);
  });

  it("never reports a binding, so the kernel never indirects through assignments", () => {
    const def = firstDef(parse(["def build", "  w = Widget.new", "  @x = Widget.new", "  w", "end"].join("\n")));
    const tail = rubyBodyTailExpression(def)!;
    expect(tail.type).toBe("identifier");
    expect(ports.isBinding(tail)).toBe(false);
    expect(ports.assignmentEvents(def, "w", { method: def, classBody: null })).toEqual([]);
  });

  it("types a memoized tail only when the site carries its class body", () => {
    const root = parse(["class Panel", "  def client", "    @client ||= Client.find(id)", "  end", "end"].join("\n"));
    const def = firstDef(root);
    const tail = rubyBodyTailExpression(def)!;
    expect(ports.typeOfExpression(tail, { method: def, classBody: null })).toBeNull();
    expect(ports.typeOfExpression(tail, { method: def, classBody: firstClassBody(root) })).toBe("Client");
  });
});

describe("inferRubyMemberReturnType", () => {
  it("types a constructor tail", () => {
    const def = firstDef(parse(["def build", "  Widget.new", "end"].join("\n")));
    expect(inferRubyMemberReturnType(def, FULL_RUBY_CATALOGUE, null)).toBe("Widget");
  });

  it("stays silent on a binding tail the service-entry ports would follow", () => {
    const def = firstDef(parse(["def build", "  w = Widget.new", "  w", "end"].join("\n")));
    expect(inferRubyMemberReturnType(def, FULL_RUBY_CATALOGUE, null)).toBeNull();
  });

  it("stays silent on a `.freeze` passthrough tail the service-entry ports would peel", () => {
    const def = firstDef(parse(["def build", "  Widget.new.freeze", "end"].join("\n")));
    expect(inferRubyMemberReturnType(def, FULL_RUBY_CATALOGUE, null)).toBeNull();
  });
});
