/**
 * ruby-walker DSL-edge + YARD-type tests (cai0 slice duzy + brg9).
 *
 * duzy — synthetic CallRefs so Rails DSL callers resolve:
 *   - `before_action :auth` / callback macros → bare-receiver CallRef to `#auth`
 *     (same-class fallback pins the callback method).
 *   - `has_many :posts` / `has_one :x` / `belongs_to :y` → a constant-ref
 *     CallRef to the associated MODEL class (file→file edge, mirrors the
 *     registry-constant-ref discipline: receiver === member === FQ constant).
 *     Model name derived by Rails convention (singularize + camelize) unless
 *     `class_name:` overrides it.
 *
 * brg9 — YARD type annotations into the walker output:
 *   - `@param x [Array<T>]` → bind `x` → element type `T` (localBindings).
 *   - `@return [T]` → `functionReturnTypes[methodName] = T`.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** All synthetic + literal CallRefs flattened across every chunk. */
function callsOf(src: string, chunks: { symbolId: string; scope: string[]; startLine: number; endLine: number }[]) {
  const tree = parse(src);
  const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks });
  return r.chunks.flatMap((c) => c.calls);
}

describe("ruby-walker duzy — callback macro edges", () => {
  it("`before_action :authenticate` emits a bare-receiver CallRef to the callback method", () => {
    const src = "class PostsController\n  before_action :authenticate\nend\n";
    const calls = callsOf(src, [{ symbolId: "PostsController", scope: ["PostsController"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "authenticate", startLine: 2 }));
  });

  it("`before_action :a, :b` emits one callback CallRef per symbol", () => {
    const src = "class C\n  before_action :a, :b\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    const members = calls.filter((c) => c.receiver === null).map((c) => c.member);
    expect(members).toContain("a");
    expect(members).toContain("b");
  });

  it("`after_save :touch_parent` (model callback) emits a callback CallRef", () => {
    const src = "class Post\n  after_save :touch_parent\nend\n";
    const calls = callsOf(src, [{ symbolId: "Post", scope: ["Post"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "touch_parent" }));
  });

  it("callback with a non-symbol arg (`if:` guard / proc) emits no spurious edge", () => {
    const src = "class C\n  before_action :auth, only: :show\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    const bareMembers = calls.filter((c) => c.receiver === null).map((c) => c.member);
    expect(bareMembers).toContain("auth");
    expect(bareMembers).not.toContain("show");
    expect(bareMembers).not.toContain("only");
  });

  it("receiver-qualified `obj.before_action :x` is NOT a callback macro", () => {
    const src = "class C\n  def m\n    obj.before_action(:x)\n  end\nend\n";
    const calls = callsOf(src, [{ symbolId: "C#m", scope: ["C", "m"], startLine: 2, endLine: 4 }]);
    // The literal `obj.before_action` call still exists, but no synthetic
    // bare-receiver edge to `x` may be emitted.
    expect(calls.filter((c) => c.receiver === null).map((c) => c.member)).not.toContain("x");
  });
});

describe("ruby-walker duzy — association model edges", () => {
  it("`has_many :posts` emits a constant-ref CallRef to the `Post` model", () => {
    const src = "class User\n  has_many :posts\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Post", member: "Post", startLine: 2 }));
  });

  it("`has_one :profile` emits a constant-ref CallRef to `Profile`", () => {
    const src = "class User\n  has_one :profile\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Profile", member: "Profile" }));
  });

  it("`belongs_to :author` emits a constant-ref CallRef to `Author`", () => {
    const src = "class Post\n  belongs_to :author\nend\n";
    const calls = callsOf(src, [{ symbolId: "Post", scope: ["Post"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Author", member: "Author" }));
  });

  it("singularizes `ies` plural — `has_many :categories` → `Category`", () => {
    const src = "class Product\n  has_many :categories\nend\n";
    const calls = callsOf(src, [{ symbolId: "Product", scope: ["Product"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Category", member: "Category" }));
  });

  it("camelizes multi-word association — `has_many :blog_posts` → `BlogPost`", () => {
    const src = "class User\n  has_many :blog_posts\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "BlogPost", member: "BlogPost" }));
  });

  it("respects explicit `class_name:` override", () => {
    const src = "class User\n  has_many :authored, class_name: 'Post'\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Post", member: "Post" }));
  });

  it("`class_name:` with a fully-qualified constant is preserved", () => {
    const src = "class User\n  has_many :memberships, class_name: 'Acme::Membership'\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Acme::Membership", member: "Acme::Membership" }));
  });

  it("receiver-qualified `obj.has_many :x` is NOT an association macro", () => {
    const src = "class C\n  def m\n    obj.has_many(:posts)\n  end\nend\n";
    const calls = callsOf(src, [{ symbolId: "C#m", scope: ["C", "m"], startLine: 2, endLine: 4 }]);
    expect(calls.map((c) => c.receiver)).not.toContain("Post");
  });
});

describe("ruby-walker brg9 — YARD element types (@param x [Array<T>])", () => {
  it("binds the element type of `@param x [Array<Post>]` → { x: 'Post' }", () => {
    const src = ["# @param x [Array<Post>]", "def f(x)", "  x.first", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ x: [{ line: 2, type: "Post" }] });
  });

  it("binds qualified element type `@param x [Array<Acme::Post>]` → { x: 'Acme::Post' }", () => {
    const src = ["# @param x [Array<Acme::Post>]", "def f(x)", "  x.each", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ x: [{ line: 2, type: "Acme::Post" }] });
  });

  it("still binds a plain `@param x [Foo]` (no regression)", () => {
    const src = ["# @param x [Foo]", "def f(x)", "  x.bar", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ x: [{ line: 2, type: "Foo" }] });
  });
});

describe("ruby-walker brg9 — YARD return types (@return [T])", () => {
  it("records `@return [User]` for the def that follows → functionReturnTypes", () => {
    const src = ["# @return [User]", "def current_user", "  fetch", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "current_user", scope: ["current_user"], startLine: 2, endLine: 4 }],
    });
    expect(r.functionReturnTypes?.current_user).toBe("User");
  });

  it("records qualified `@return [Acme::User]`", () => {
    const src = ["# @return [Acme::User]", "def build", "  make", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "build", scope: ["build"], startLine: 2, endLine: 4 }],
    });
    expect(r.functionReturnTypes?.build).toBe("Acme::User");
  });

  it("combines `@param` and `@return` on the same def", () => {
    const src = ["# @param id [Integer]", "# @return [User]", "def find_user(id)", "  User.find(id)", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "find_user", scope: ["find_user"], startLine: 3, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ id: [{ line: 3, type: "Integer" }] });
    expect(r.functionReturnTypes?.find_user).toBe("User");
  });

  it("does NOT record `@return [Array<User>]` (collection, not a single instance)", () => {
    const src = ["# @return [Array<User>]", "def all_users", "  fetch", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "all_users", scope: ["all_users"], startLine: 2, endLine: 4 }],
    });
    expect(r.functionReturnTypes?.all_users).toBeUndefined();
  });

  it("leaves functionReturnTypes undefined when no @return annotations exist", () => {
    const src = ["def plain", "  helper", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "plain", scope: ["plain"], startLine: 1, endLine: 3 }],
    });
    expect(r.functionReturnTypes).toBeUndefined();
  });

  it("type tracking gate off → no functionReturnTypes, no YARD localBindings", () => {
    const prev = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = ["# @return [User]", "# @param x [Array<Post>]", "def f(x)", "  x.first", "end"].join("\n");
      const tree = parse(`${src}\n`);
      const r = extractFromRubyFile({
        tree,
        code: src,
        relPath: "x.rb",
        language: "ruby",
        chunks: [{ symbolId: "f", scope: ["f"], startLine: 3, endLine: 5 }],
      });
      expect(r.functionReturnTypes).toBeUndefined();
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
      else process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = prev;
    }
  });
});

describe("ruby-walker — dispatch tables (registry-constant-ref, pq02v)", () => {
  it("CONST = { key => ClassName } hash literal emits dispatchTables entry with string key", () => {
    const src = "HANDLERS = { 'create' => CreateHandler, 'update' => UpdateHandler }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables).toBeDefined();
    expect(r.dispatchTables?.["HANDLERS"]).toMatchObject({
      entries: { create: "CreateHandler", update: "UpdateHandler" },
    });
  });

  it("CONST = { sym: ClassName } symbol-key hash emits dispatchTables entry with symbol key", () => {
    const src = "REGISTRY = { create: CreateService, delete: DeleteService }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables?.["REGISTRY"]).toMatchObject({
      entries: { create: "CreateService", delete: "DeleteService" },
    });
  });

  it("CONST = [ClassA, ClassB] array literal emits dispatchTables with positional indices", () => {
    const src = "PIPELINE = [ValidatorClass, ProcessorClass]\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables?.["PIPELINE"]).toMatchObject({
      entries: { "0": "ValidatorClass", "1": "ProcessorClass" },
    });
  });

  it("CONST = { k => Klass }.freeze emits dispatchTables (unwraps freeze call)", () => {
    const src = "HANDLERS = { 'run' => RunHandler }.freeze\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables?.["HANDLERS"]).toBeDefined();
    expect(r.dispatchTables?.["HANDLERS"].entries).toMatchObject({ run: "RunHandler" });
  });

  it("hash with computed (non-literal) key → entry is dropped", () => {
    const src = "MAP = { method_name => Handler }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    // computed key → no entries → table is omitted entirely
    expect(r.dispatchTables?.["MAP"]).toBeUndefined();
  });

  it("hash with non-constant value → value entry is dropped", () => {
    const src = "MAP = { 'action' => build_handler() }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables?.["MAP"]).toBeUndefined();
  });

  it("scope_resolution constant as hash key value → emits qualified constant", () => {
    const src = "HANDLERS = { 'go' => Acme::GoHandler }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables?.["HANDLERS"]?.entries?.["go"]).toBe("Acme::GoHandler");
  });

  it("no constant-assignment → no dispatchTables key", () => {
    const src = "x = { 'a' => Foo }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.dispatchTables).toBeUndefined();
  });
});

describe("ruby-walker — registry constant-value refs (collectRegistryConstantValueRefs, ki9v)", () => {
  it("constant values inside a hash literal emit synthetic CallRefs for the assigned constant", () => {
    const src = "HANDLERS = { 'run' => RunHandler }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "HANDLERS", scope: [], startLine: 1, endLine: 1 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    expect(allCalls).toContainEqual(expect.objectContaining({ receiver: "RunHandler", member: "RunHandler" }));
  });

  it("scope_resolution constant value in hash emits qualified CallRef", () => {
    const src = "MAP = { 'go' => Acme::GoHandler }\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "MAP", scope: [], startLine: 1, endLine: 1 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    expect(allCalls).toContainEqual(
      expect.objectContaining({ receiver: "Acme::GoHandler", member: "Acme::GoHandler" }),
    );
  });
});

describe("ruby-walker — inheritance edges (collectRubyInheritanceEdges, lz8t)", () => {
  function inheritanceEdgesOf(src: string) {
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    return r.inheritanceEdges ?? [];
  }

  it("`class Foo < Bar` emits a super edge (kind=super, ordinal=0)", () => {
    const edges = inheritanceEdgesOf("class Foo < Bar\nend\n");
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "Foo", ancestor: "Bar", kind: "super", ordinal: 0 }),
    );
  });

  it("`include Mod` inside class body emits an include edge", () => {
    const edges = inheritanceEdgesOf("class Foo\n  include Trackable\nend\n");
    expect(edges).toContainEqual(expect.objectContaining({ source: "Foo", ancestor: "Trackable", kind: "include" }));
  });

  it("`extend Mod` inside class body emits an extend edge", () => {
    const edges = inheritanceEdgesOf("class Foo\n  extend ClassMethods\nend\n");
    expect(edges).toContainEqual(expect.objectContaining({ source: "Foo", ancestor: "ClassMethods", kind: "extend" }));
  });

  it("`prepend Mod` emits a prepend edge", () => {
    const edges = inheritanceEdgesOf("class Foo\n  prepend Instrumentation\nend\n");
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "Foo", ancestor: "Instrumentation", kind: "prepend" }),
    );
  });

  it("multiple include/extend in ordinal order", () => {
    const edges = inheritanceEdgesOf("class Foo\n  include A\n  include B\nend\n");
    const includes = edges.filter((e) => e.kind === "include");
    expect(includes[0]).toMatchObject({ ancestor: "A", ordinal: 0 });
    expect(includes[1]).toMatchObject({ ancestor: "B", ordinal: 1 });
  });

  it("no inheritance → inheritanceEdges is undefined (empty result not set)", () => {
    const tree = parse("class Plain\nend\n");
    const r = extractFromRubyFile({ tree, code: "class Plain\nend\n", relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.inheritanceEdges).toBeUndefined();
  });

  it("nested class with superclass emits fully-qualified source name", () => {
    const edges = inheritanceEdgesOf("module Acme\n  class Auth < Base\n  end\nend\n");
    expect(edges).toContainEqual(expect.objectContaining({ source: "Acme::Auth", ancestor: "Base", kind: "super" }));
  });

  it("scope_resolution superclass (class Foo < Acme::Base) is recognised", () => {
    const edges = inheritanceEdgesOf("class Foo < Acme::Base\nend\n");
    expect(edges).toContainEqual(expect.objectContaining({ source: "Foo", ancestor: "Acme::Base", kind: "super" }));
  });
});

describe("ruby-walker — has_and_belongs_to_many association model edge", () => {
  it("`has_and_belongs_to_many :roles` emits constant-ref CallRef to `Role`", () => {
    const src = "class User\n  has_and_belongs_to_many :roles\nend\n";
    const calls = (() => {
      const tree = parse(src);
      const r = extractFromRubyFile({
        tree,
        code: src,
        relPath: "x.rb",
        language: "ruby",
        chunks: [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }],
      });
      return r.chunks.flatMap((c) => c.calls);
    })();
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Role", member: "Role" }));
  });
});

describe("ruby-walker — class_name: with constant node (scope_resolution / constant)", () => {
  it("`class_name: SomeClass` (constant node) resolves to the constant text", () => {
    const src = "class Post\n  belongs_to :author, class_name: Author\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Post", scope: ["Post"], startLine: 1, endLine: 3 }],
    });
    const calls = r.chunks.flatMap((c) => c.calls);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Author", member: "Author" }));
  });
});
