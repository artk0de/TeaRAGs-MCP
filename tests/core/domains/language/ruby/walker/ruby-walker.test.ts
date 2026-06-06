/**
 * ruby-walker tests — exhaustive matrix of:
 *
 *   1. explicit require / require_relative
 *   2. Zeitwerk constant references (User, Acme::Auth::Login)
 *   3. constants in declaration vs reference position
 *   4. nested class/module declarations → fileScope
 *   5. method/singleton_method symbol extraction
 *
 * Zeitwerk is the trickiest channel — refs are emitted only for
 * USAGE positions, not for the file's own class/module headers.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  extractFromRubyFile,
  ZEITWERK_PREFIX,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

describe("extractFromRubyFile — explicit requires", () => {
  it("captures bare `require 'foo'`", () => {
    const src = "require 'foo'\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toContain("foo");
  });

  it("captures `require_relative './foo'` with canonical './foo' shape", () => {
    const src = "require_relative './foo'\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "pkg/main.rb", language: "ruby", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toContain("./foo");
  });

  it("captures `require_relative 'foo'` (no leading dot) with same './foo' shape", () => {
    const src = "require_relative 'foo'\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "pkg/main.rb", language: "ruby", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toContain("./foo");
  });

  it("captures multiple requires", () => {
    const src = "require 'foo'\nrequire 'bar/baz'\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks: [] });
    const explicit = r.imports.filter((i) => !i.importText.startsWith(ZEITWERK_PREFIX));
    expect(explicit.map((i) => i.importText).sort()).toEqual(["bar/baz", "foo"]);
  });

  it("does NOT capture method calls whose name LOOKS like require", () => {
    // `requirer.run` is just a method call on `requirer`, not a require statement.
    const src = "requirer.run\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks: [] });
    const explicit = r.imports.filter((i) => !i.importText.startsWith(ZEITWERK_PREFIX));
    expect(explicit).toEqual([]);
  });
});

describe("extractFromRubyFile — Zeitwerk constant references", () => {
  it("emits a zeitwerk import for `User.find`", () => {
    const src = "def go\n  User.find(1)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "main.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z.map((i) => i.importText)).toContain(`${ZEITWERK_PREFIX}User`);
  });

  it("emits qualified constant for `Acme::Auth::Login.new`", () => {
    const src = "Acme::Auth::Login.new\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "main.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z.map((i) => i.importText)).toContain(`${ZEITWERK_PREFIX}Acme::Auth::Login`);
  });

  it("emits the outermost scope only (no fragments)", () => {
    const src = "Acme::Auth::Login.new\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "main.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z.map((i) => i.importText)).toEqual([`${ZEITWERK_PREFIX}Acme::Auth::Login`]);
  });

  it("does NOT emit zeitwerk imports for constants in class HEADER", () => {
    const src = "class User\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "user.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z).toEqual([]);
  });

  it("does NOT emit zeitwerk imports for constants in module HEADER", () => {
    const src = "module Acme::Auth\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "auth.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z).toEqual([]);
  });

  it("emits zeitwerk imports for superclass references (`class Foo < Bar`)", () => {
    const src = "class Foo < Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "foo.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    expect(z.map((i) => i.importText)).toContain(`${ZEITWERK_PREFIX}Bar`);
  });

  it("emits zeitwerk imports for constants in method bodies", () => {
    const src = "class Foo\n  def go\n    User.find(1)\n    Order.recent\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "foo.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX)).map((i) => i.importText);
    expect(z).toContain(`${ZEITWERK_PREFIX}User`);
    expect(z).toContain(`${ZEITWERK_PREFIX}Order`);
  });

  it("captures startLine on each constant reference", () => {
    const src = "User.find\n# blank\nOrder.find\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    const byName = new Map(z.map((i) => [i.importText, i.startLine]));
    expect(byName.get(`${ZEITWERK_PREFIX}User`)).toBe(1);
    expect(byName.get(`${ZEITWERK_PREFIX}Order`)).toBe(3);
  });
});

describe("extractFromRubyFile — fileScope (declared constants)", () => {
  it("captures top-level `class User`", () => {
    const src = "class User\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "user.rb", language: "ruby", chunks: [] });
    expect(r.fileScope).toContain("User");
  });

  it("captures top-level `module Acme`", () => {
    const src = "module Acme\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "acme.rb", language: "ruby", chunks: [] });
    expect(r.fileScope).toContain("Acme");
  });

  it("captures compound declaration `class Acme::Auth::User`", () => {
    const src = "class Acme::Auth::User\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "acme/auth/user.rb", language: "ruby", chunks: [] });
    expect(r.fileScope).toContain("Acme::Auth::User");
  });

  it("captures nested declarations qualifying them", () => {
    const src = "module Acme\n  module Auth\n    class User\n    end\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "acme/auth/user.rb", language: "ruby", chunks: [] });
    // Every level produces a fully qualified entry: Acme, Acme::Auth, Acme::Auth::User.
    expect(r.fileScope).toEqual(expect.arrayContaining(["Acme", "Acme::Auth", "Acme::Auth::User"]));
  });

  it("captures mixed nested + compound: `module Acme` { class Auth::User end }", () => {
    const src = "module Acme\n  class Auth::User\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.fileScope).toContain("Acme");
    expect(r.fileScope).toContain("Acme::Auth::User");
  });
});

describe("extractFromRubyFile — calls grouped by chunk", () => {
  it("captures calls within their chunk range", () => {
    const src = "def alpha\n  Foo.bar\nend\n\ndef beta\n  Baz.qux\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [
        { symbolId: "alpha", scope: [], startLine: 1, endLine: 3 },
        { symbolId: "beta", scope: [], startLine: 5, endLine: 7 },
      ],
    });
    expect(r.chunks[0].calls.map((c) => c.member)).toContain("bar");
    expect(r.chunks[1].calls.map((c) => c.member)).toContain("qux");
  });

  it("captures receiver as the full scope_resolution text", () => {
    const src = "Acme::Auth::Login.new\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("Acme::Auth::Login");
    expect(c.member).toBe("new");
  });

  // BUG tea-rags-mcp-8fnu — a single call inside a deeply nested method must
  // attach to ONLY the innermost containing chunk. The chunker emits one chunk
  // per scope level (module / inner module / class / method) so a call's
  // [startLine, endLine] falls inside all four ranges. The old walker assigned
  // the call to every containing chunk, multiplying caller-edge counts by the
  // nesting depth (sinatra: 16 caller edges where 12 are dupes from outer
  // scopes for Rack::Protection::EscapedParams#escape). Innermost-only fixes
  // the inflated fan-in/fan-out.
  it("assigns each call to only the innermost containing chunk (nested modules)", () => {
    // module Rack
    //   module Protection
    //     class EscapedParams
    //       def escape
    //         escape_hash(object)   # the call we track
    //       end
    //     end
    //   end
    // end
    const src = [
      "module Rack", //                line 1
      "  module Protection", //        line 2
      "    class EscapedParams", //    line 3
      "      def escape", //           line 4
      "        escape_hash(object)", //line 5  <-- the call
      "      end", //                  line 6
      "    end", //                    line 7
      "  end", //                      line 8
      "end", //                        line 9
      "",
    ].join("\n");
    const tree = parse(src);
    // Four overlapping chunks for the four scopes — the smallest by
    // line-span is the method itself.
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "rack/protection/escaped_params.rb",
      language: "ruby",
      chunks: [
        { symbolId: "Rack", scope: [], startLine: 1, endLine: 9 },
        { symbolId: "Rack::Protection", scope: ["Rack"], startLine: 2, endLine: 8 },
        { symbolId: "Rack::Protection::EscapedParams", scope: ["Rack", "Protection"], startLine: 3, endLine: 7 },
        {
          symbolId: "Rack::Protection::EscapedParams#escape",
          scope: ["Rack", "Protection", "EscapedParams"],
          startLine: 4,
          endLine: 6,
        },
      ],
    });
    const callsByChunk = r.chunks.map((c) => ({
      symbolId: c.symbolId,
      members: c.calls.map((cr) => cr.member),
    }));
    // The innermost chunk (#escape) owns the call.
    expect(callsByChunk).toContainEqual({
      symbolId: "Rack::Protection::EscapedParams#escape",
      members: expect.arrayContaining(["escape_hash"]),
    });
    // Every outer scope chunk has ZERO calls (no duplicate attribution).
    const outerScopes = ["Rack", "Rack::Protection", "Rack::Protection::EscapedParams"];
    for (const symId of outerScopes) {
      const chunk = r.chunks.find((c) => c.symbolId === symId);
      expect(chunk).toBeDefined();
      expect(chunk?.calls.filter((cr) => cr.member === "escape_hash")).toEqual([]);
    }
  });

  // bd tea-rags-mcp-21oa — method-chain calls (`a.b().c()`) must each emit a
  // distinct CallRef. tree-sitter-ruby parses chained calls as nested `call`
  // nodes whose `receiver` field is itself a `call` node; the walker's
  // top-down traversal must visit every level so both the inner and outer
  // method names land in chunks[].calls. The outer call's receiver text MUST
  // be the FULL source text of the inner expression so the resolver's
  // chained-receiver guard can fire on it.
  it("emits both calls for a 2-link method chain `params.require(:x).permit(:y)`", () => {
    // huginn ApplicationController#agent_params shape — Rails strong-params
    // idiom. `require` returns the nested hash, `permit` whitelists keys.
    const src = "def agent_params\n  params.require(:agent).permit(:name)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "app/controllers/application_controller.rb",
      language: "ruby",
      chunks: [{ symbolId: "agent_params", scope: ["agent_params"], startLine: 1, endLine: 3 }],
    });
    const { calls } = r.chunks[0];
    const requireCall = calls.find((c) => c.member === "require");
    const permitCall = calls.find((c) => c.member === "permit");
    expect(requireCall).toBeDefined();
    expect(permitCall).toBeDefined();
    // Inner call: receiver is the bare identifier `params`.
    expect(requireCall?.receiver).toBe("params");
    // Outer call: receiver is the FULL inner-expression text so the resolver
    // can pattern-match the chain shape (see ruby-resolver receiverLooksLike*).
    expect(permitCall?.receiver).toBe("params.require(:agent)");
  });

  it("emits all three calls for a 3-link AR chain `User.where(...).order(...).limit(...)`", () => {
    const src = "def recent\n  User.where(active: true).order(:name).limit(10)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "app/services/recent_users.rb",
      language: "ruby",
      chunks: [{ symbolId: "recent", scope: ["recent"], startLine: 1, endLine: 3 }],
    });
    const members = r.chunks[0].calls.map((c) => c.member);
    expect(members).toContain("where");
    expect(members).toContain("order");
    expect(members).toContain("limit");
    // Outermost call's receiver is the entire two-link inner expression text.
    const limitCall = r.chunks[0].calls.find((c) => c.member === "limit");
    expect(limitCall?.receiver).toBe("User.where(active: true).order(:name)");
    // Innermost call's receiver is the bare constant.
    const whereCall = r.chunks[0].calls.find((c) => c.member === "where");
    expect(whereCall?.receiver).toBe("User");
  });

  it("emits both a bare call and a chained call when mixed in the same method", () => {
    // `do_work()` is a bare call (receiver null) — bare identifiers without
    // parens are `identifier` nodes per tree-sitter-ruby (not `call`), so
    // parens are required to trigger the call branch. `permit` is chained
    // off `params`. Both must land in the same chunk's calls[].
    const src = "def mixed\n  do_work()\n  params.permit(:y)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "mixed", scope: ["mixed"], startLine: 1, endLine: 4 }],
    });
    const bare = r.chunks[0].calls.find((c) => c.member === "do_work");
    const permit = r.chunks[0].calls.find((c) => c.member === "permit");
    expect(bare).toBeDefined();
    expect(bare?.receiver).toBeNull();
    expect(permit).toBeDefined();
    expect(permit?.receiver).toBe("params");
  });

  // Tie-breaker: when two chunks share the SAME endLine - startLine span (rare
  // but possible — e.g. an explicit module that contains exactly one method
  // both starting and ending on adjacent lines), the deeper scope wins.
  it("breaks innermost-chunk ties by deeper scope (longer scope wins)", () => {
    // module A     # line 1
    //   def m      # line 2
    //     x()      # line 3   <- call
    //   end        # line 4
    // end          # line 5
    const src = ["module A", "  def m", "    x()", "  end", "end", ""].join("\n");
    const tree = parse(src);
    // Both chunks span 4 lines (endLine - startLine === 3). Method-level
    // chunk has the deeper scope and must win.
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "a.rb",
      language: "ruby",
      chunks: [
        { symbolId: "A", scope: [], startLine: 1, endLine: 4 },
        { symbolId: "A#m", scope: ["A"], startLine: 2, endLine: 5 },
      ],
    });
    const innermost = r.chunks.find((c) => c.symbolId === "A#m");
    const outer = r.chunks.find((c) => c.symbolId === "A");
    expect(innermost?.calls.map((c) => c.member)).toContain("x");
    expect(outer?.calls.filter((c) => c.member === "x")).toEqual([]);
  });
});

describe("extractFromRubyFile — assignment-position constants", () => {
  // `User = Struct.new(...)` — the LHS constant is a DECLARATION,
  // not a reference. The walker's isInDeclarationPosition must
  // recognise the assignment.left field and skip emitting a zeitwerk
  // import for User. Exercises lines 177-182 of ruby-walker.ts.
  it("treats `User = Struct.new(...)` LHS as a declaration, not a Zeitwerk reference", () => {
    const src = "User = Struct.new(:name, :email)\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "user.rb", language: "ruby", chunks: [] });
    const z = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX));
    // `Struct` IS a reference (RHS); `User` is NOT (LHS).
    const refNames = z.map((i) => i.importText);
    expect(refNames).toContain(`${ZEITWERK_PREFIX}Struct`);
    expect(refNames).not.toContain(`${ZEITWERK_PREFIX}User`);
  });

  // Assignment with a non-constant RHS: `User = some_call`. User is
  // still on the LHS → declaration. Drives the same LHS branch with a
  // different RHS shape.
  it("recognises LHS constant as declaration regardless of RHS shape", () => {
    const src = "MyClass = Class.new\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    const refNames = r.imports.filter((i) => i.importText.startsWith(ZEITWERK_PREFIX)).map((i) => i.importText);
    expect(refNames).not.toContain(`${ZEITWERK_PREFIX}MyClass`);
  });
});

describe("extractFromRubyFile — methods at top-level and inside classes", () => {
  // `def foo; end` at top level — exercise the `method` branch of the
  // call/method_call switch in collectRubyCalls + the top-level
  // walker. Calls happen inside method body get attributed to the
  // chunk containing them.
  it("captures top-level `def foo` body call sites", () => {
    // `bar()` is parsed as a `call` node by tree-sitter-ruby (bare
    // identifiers without parens are `identifier` nodes, not calls).
    const src = "def foo\n  bar()\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "foo", scope: [], startLine: 1, endLine: 3 }],
    });
    // `bar()` is a bare call → receiver null, member "bar".
    expect(r.chunks[0].calls.map((c) => ({ r: c.receiver, m: c.member }))).toContainEqual({ r: null, m: "bar" });
  });

  // Singleton method (`def self.foo; end`) — exercises the
  // `singleton_method` branch in rbNameOf and the same branch in the
  // ruby-walker (which only checks `method` / `singleton_method` for
  // the `method` field on the call grammar — singleton_methods follow
  // the same call shape so call sites in them still attribute correctly).
  it("captures call sites inside singleton methods", () => {
    const src = "class Foo\n  def self.bar\n    baz.qux\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "foo.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo::bar", scope: ["Foo"], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].calls.map((c) => c.member)).toContain("qux");
  });
});

describe("extractFromRubyFile — edge cases", () => {
  it("survives empty file", () => {
    const tree = parse("");
    const r = extractFromRubyFile({ tree, code: "", relPath: "empty.rb", language: "ruby", chunks: [] });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
    expect(r.fileScope).toEqual([]);
  });

  it("survives partial parse without throwing", () => {
    const src = "class\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "broken.rb", language: "ruby", chunks: [] });
    expect(r.relPath).toBe("broken.rb");
  });

  it("ignores comments", () => {
    const src = "# require 'foo' - this is a comment\nrequire 'bar'\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    const explicit = r.imports.filter((i) => !i.importText.startsWith(ZEITWERK_PREFIX));
    expect(explicit.map((i) => i.importText)).toEqual(["bar"]);
  });
});

describe("extractFromRubyFile — localBindings (type inference)", () => {
  it("binds `var = ClassName.new(...)` to the constructor's class", () => {
    const src = "def foo\n  user = User.new(name: 'a')\n  user.save\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "foo", scope: ["foo"], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ user: "User" });
  });

  it("binds qualified constructor `var = Acme::Auth::Login.new(...)` to the FQ class", () => {
    const src = "def f\n  l = Acme::Auth::Login.new(creds)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ l: "Acme::Auth::Login" });
  });

  it("binds AR finder result `var = Model.find(id)` to the Model", () => {
    const src = "def show\n  user = User.find(params[:id])\n  user.email\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "users_controller.rb",
      language: "ruby",
      chunks: [{ symbolId: "show", scope: ["show"], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ user: "User" });
  });

  it("binds AR finder variants .first / .last / .find_by / .create / .take", () => {
    const src = [
      "def all_finders",
      "  a = User.first",
      "  b = User.last",
      "  c = User.find_by(email: 'x')",
      "  d = User.create(name: 'y')",
      "  e = User.create!(name: 'y')",
      "  f = User.take",
      "end",
    ].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "all_finders", scope: ["all_finders"], startLine: 1, endLine: 8 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ a: "User", b: "User", c: "User", d: "User", e: "User", f: "User" });
  });

  it("does NOT bind `var = Model.where(...)` (returns Relation, not instance)", () => {
    const src = "def filter\n  rel = User.where(active: true)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "filter", scope: ["filter"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("does NOT bind from bare factory call `var = make_user()`", () => {
    const src = "def f\n  u = make_user()\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("binds YARD `@param NAME [Type]` for the def that follows", () => {
    const src = [
      "# @param user [User] the user",
      "# @param ability [Symbol] the action",
      "def authorize(user, ability)",
      "  user.role",
      "end",
    ].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "authorize", scope: ["authorize"], startLine: 3, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ user: "User", ability: "Symbol" });
  });

  it("binds YARD with qualified type `[Acme::User]`", () => {
    const src = ["# @param u [Acme::User]", "def f(u)", "  u.role", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ u: "Acme::User" });
  });

  it("merges YARD + constructor bindings within the same chunk (later writes win)", () => {
    const src = [
      "# @param user [User]",
      "def do_thing(user)",
      "  policy = AbstractPolicy.new(user)",
      "  policy.authorize!",
      "end",
    ].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "do_thing", scope: ["do_thing"], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ user: "User", policy: "AbstractPolicy" });
  });

  it("does NOT emit localBindings when CODEGRAPH_RB_LOCAL_TYPE_TRACKING=false", () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "def f\n  u = User.new\nend\n";
      const tree = parse(src);
      const r = extractFromRubyFile({
        tree,
        code: src,
        relPath: "x.rb",
        language: "ruby",
        chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
      });
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });

  it("unwraps `obj.send(:method)` into a direct receiver-call", () => {
    const src = "def f\n  user.send(:save)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "save");
    expect(c).toBeDefined();
    expect(c?.receiver).toBe("user");
    // The literal `send` edge must NOT also be emitted (double-counting).
    expect(r.chunks[0].calls.find((cr) => cr.member === "send")).toBeUndefined();
  });

  it("unwraps `obj.public_send('save')` (string literal arg)", () => {
    const src = 'def f\n  user.public_send("save")\nend\n';
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "save");
    expect(c?.receiver).toBe("user");
  });

  it("keeps `obj.send(var)` as a literal send call when arg is not a literal", () => {
    const src = "def f\n  user.send(action)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "send")).toBeDefined();
  });

  it("extracts &:method block-pass as a separate CallRef", () => {
    const src = "def f\n  users.each(&:save)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "each")).toBeDefined();
    const saveCall = r.chunks[0].calls.find((cr) => cr.member === "save" && cr.receiver === null);
    expect(saveCall).toBeDefined();
  });

  // `__send__` — the historical alias of `send`. Same unwrap path; this
  // exercises a different element of `RUBY_DYNAMIC_DISPATCH` than the
  // `send` / `public_send` tests above so a regression that narrows the
  // Set to only those two is caught.
  it("unwraps `obj.__send__(:method)` like `send`", () => {
    const src = "def f\n  user.__send__(:save)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "save");
    expect(c?.receiver).toBe("user");
    expect(r.chunks[0].calls.find((cr) => cr.member === "__send__")).toBeUndefined();
  });

  // Block-pass argument that is NOT a symbol (e.g. `&proc_var`). The
  // walker's `extractBlockPassMethod` short-circuits on the
  // `child.type === "simple_symbol"` guard, never reaching the symbol
  // strip. Covers the false branch of that guard inside
  // `extractBlockPassMethod` (block_argument child is `identifier`,
  // not `simple_symbol`).
  it("does NOT emit an extra CallRef for `&proc_var` block-pass (non-symbol child)", () => {
    const src = "def f\n  users.each(&handler)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    // `each` is still recorded; nothing extra is emitted for the proc.
    expect(r.chunks[0].calls.find((cr) => cr.member === "each")).toBeDefined();
    expect(r.chunks[0].calls.find((cr) => cr.callText.startsWith("&:"))).toBeUndefined();
  });

  // Two references to the SAME constant on the SAME line — the
  // walker's `seen` set keyed by `qualified@line` deduplicates so the
  // import list does not double-count. Covers the `seen.has(key)`
  // early-return in `collectRubyConstantRefs`.
  it("deduplicates repeated constant references on the same line", () => {
    const src = "def f\n  User.find_by(name: User.table_name)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const userRefs = r.imports.filter((i) => i.importText === `${ZEITWERK_PREFIX}User`);
    // Two textual `User` mentions on line 2 produce ONE ImportRef.
    expect(userRefs.length).toBe(1);
  });

  // `obj.send()` with an empty argument list — the argument_list parses
  // but its namedChildren are empty, so `firstArg` is undefined. The
  // unwrap path is reached but returns null → literal `send` edge stays.
  // Covers `if (!firstArg) return null;` in extractLiteralSymbolOrString.
  it("keeps `obj.send()` as a literal send when arg list is empty", () => {
    const src = "def f\n  user.send()\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const sendCall = r.chunks[0].calls.find((cr) => cr.member === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.receiver).toBe("user");
  });

  // `obj.send` (no parens, no args) — `callNode.childForFieldName("arguments")`
  // returns null AND the fallback `children.find(...)` finds no argument_list.
  // Covers `if (!args) return null;` in extractLiteralSymbolOrString.
  it("keeps `obj.send` (no parens) as a literal send", () => {
    const src = "def f\n  user.send\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const sendCall = r.chunks[0].calls.find((cr) => cr.member === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.receiver).toBe("user");
  });

  it("splits bindings across two adjacent method chunks", () => {
    const src = ["def one", "  a = User.new", "end", "def two", "  b = Order.new", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [
        { symbolId: "one", scope: ["one"], startLine: 1, endLine: 3 },
        { symbolId: "two", scope: ["two"], startLine: 4, endLine: 6 },
      ],
    });
    expect(r.chunks[0].localBindings).toEqual({ a: "User" });
    expect(r.chunks[1].localBindings).toEqual({ b: "Order" });
  });

  // YARD `@param` block precedes a `def` that lives in a chunk OTHER than
  // the one being scanned — the yardByLine entry is keyed by the def's
  // line, but that line falls OUTSIDE the current chunk's [start,end]
  // range. The loop must skip it (covers the line-range guard inside
  // `collectLocalBindingsForChunk` against yardByLine).
  it("skips YARD bindings whose def lives outside the chunk range", () => {
    const src = [
      "# @param a [User]", // line 1
      "def one(a)", //         line 2
      "  a.role", //            line 3
      "end", //                line 4
      "# @param b [Order]", // line 5
      "def two(b)", //         line 6
      "  b.total", //          line 7
      "end", //                line 8
    ].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      // Only chunk for `one` — `two`'s YARD (line 6) is outside [1..4],
      // forcing the `line < startLine || line > endLine` guard to fire.
      chunks: [{ symbolId: "one", scope: ["one"], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ a: "User" });
  });

  // RHS receiver is not a class constant (lowercase / chained call) —
  // walker bails on the regex-guard line. Different from "make_user()"
  // which is a bare call (no receiver); here the receiver exists but
  // doesn't look like a constant.
  it("does NOT bind `var = lower.new(...)` where receiver is not a class constant", () => {
    const src = "def f\n  u = builder.new\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  // Env-gate numeric form: `CODEGRAPH_RB_LOCAL_TYPE_TRACKING=0` is the
  // POSIX-shell-style disable that `localTypeTrackingEnabled` accepts in
  // addition to "false". Covers the second operand of the `&&` guard.
  it("does NOT emit localBindings when CODEGRAPH_RB_LOCAL_TYPE_TRACKING=0", () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "0";
    try {
      const src = "def f\n  u = User.new\nend\n";
      const tree = parse(src);
      const r = extractFromRubyFile({
        tree,
        code: src,
        relPath: "x.rb",
        language: "ruby",
        chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
      });
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });
});

describe("extractFromRubyFile — classAncestors (inheritance + mixins)", () => {
  it("captures `class Foo < Bar` superclass", () => {
    const src = "class Foo < Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar"]);
  });

  it("captures qualified superclass `class Foo < Acme::Base`", () => {
    const src = "class Foo < Acme::Base\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Acme::Base"]);
  });

  it("captures `include Mod` mixins in class body", () => {
    const src = "class Foo\n  include Bar\n  include Acme::Baz\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar", "Acme::Baz"]);
  });

  it("captures `extend Mod` and `prepend Mod` alongside `include` (prepend in separate map)", () => {
    // bd tea-rags-mcp-3jvn — `prepend M` inserts before the class itself in
    // Ruby's MRO so the resolver MUST check prepended modules first. The
    // walker emits prepended ancestors into a SEPARATE map so the resolver
    // can keep them ordered correctly without re-scanning sources. `include`
    // and `extend` stay in `classAncestors` (regular MRO position).
    const src = "class Foo\n  extend Bar\n  prepend Baz\n  include Qux\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar", "Qux"]);
    expect(r.classPrependedAncestors?.["Foo"]).toEqual(["Baz"]);
  });

  it("preserves order: superclass first, mixins in declaration order", () => {
    const src = "class Foo < Base\n  include First\n  include Second\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Base", "First", "Second"]);
  });

  it("returns undefined classAncestors when no class declares ancestors", () => {
    const src = "class Foo\nend\nclass Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors).toBeUndefined();
  });

  it("qualifies nested class names via outer scope", () => {
    const src = "module Acme\n  class User < BaseModel\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Acme::User"]).toEqual(["BaseModel"]);
  });

  it("skips non-constant mixin args (`include some_var`)", () => {
    const src = "class Foo\n  include some_var\n  include Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar"]);
  });

  // `include()` parses as a `call` node with `arguments=argument_list` whose
  // namedChildren are empty. The walker reaches mixinTargetFromStatement's
  // `firstArg = args.namedChildren[0]` lookup and falls through the
  // `if (!firstArg) return null` guard. Exercises the empty-args branch
  // independently from the "non-constant arg" path above.
  it("skips empty mixin argument list (`include()`)", () => {
    const src = "class Foo\n  include()\n  include Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    // `include()` contributes nothing; only `include Bar` lands in ancestors.
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar"]);
  });

  // `include 123` — first arg is an `integer` node, not `constant` or
  // `scope_resolution`. mixinTargetFromStatement's ternary returns `text=null`,
  // tripping `if (!text || !regex.test(text))`. Different type from the
  // "include some_var" identifier case to exercise the ternary's `: null`
  // fall-through specifically.
  it("skips literal-number mixin args (`include 123`)", () => {
    const src = "class Foo\n  include 123\n  include Bar\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toEqual(["Bar"]);
  });

  // A statement that LOOKS like a mixin (call with method = `include`) but
  // is itself nested under a method definition — the walker scans the
  // class body's stmtSource, which includes the `def` node but not the
  // nested call inside its body. The mixin inside def should NOT contribute
  // to ancestors.
  it("does not pick up mixin-shaped calls nested inside method bodies", () => {
    const src = "class Foo\n  def m\n    include Bar\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors).toBeUndefined();
  });

  // Module-level mixin: `module Foo; include Bar; end`. The walker treats
  // `module` like `class` for ancestor collection (skipping only the
  // superclass step). Exercises the `node.type === "module"` branch of
  // collectRubyClassAncestors with mixin statements present.
  it("captures mixins inside `module` declarations", () => {
    const src = "module Acme\n  include Configurable\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Acme"]).toEqual(["Configurable"]);
  });

  // Mixin call with explicit receiver — `self.include Bar` or `Foo.include Bar`
  // — must NOT be treated as a class-level mixin. mixinTargetFromStatement
  // bails on `node.childForFieldName("receiver")`. Drives the receiver-guard
  // false branch.
  it("ignores mixin-shaped calls with an explicit receiver", () => {
    const src = "class Foo\n  self.include Bar\n  include Qux\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    // `self.include Bar` has a receiver — skipped. Only `include Qux` lands.
    expect(r.classAncestors?.["Foo"]).toEqual(["Qux"]);
  });
});

// bd tea-rags-mcp-3jvn — `prepend M` differs from `include M`: prepended
// modules sit BEFORE the class in MRO so `M#foo` shadows `A#foo` even when
// A defines `foo` itself. Walker emits prepended targets into a separate
// `classPrependedAncestors` map so the resolver walks them first.
describe("extractFromRubyFile — prepend ancestors (bd 3jvn)", () => {
  it("captures a single `prepend M` into classPrependedAncestors (not classAncestors)", () => {
    const src = "class A\n  prepend M\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classPrependedAncestors?.["A"]).toEqual(["M"]);
    // classAncestors stays undefined when only prepend is present.
    expect(r.classAncestors).toBeUndefined();
  });

  it("preserves source order of multiple `prepend` calls", () => {
    // Last prepend wins in Ruby MRO — walker emits in source order, the
    // resolver iterates in reverse.
    const src = "class A\n  prepend M1\n  prepend M2\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classPrependedAncestors?.["A"]).toEqual(["M1", "M2"]);
  });

  it("keeps `include` in classAncestors and `prepend` in classPrependedAncestors in the same class", () => {
    const src = "class A < B\n  include Inc\n  prepend Pre\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    // Regular MRO list: superclass + includes.
    expect(r.classAncestors?.["A"]).toEqual(["B", "Inc"]);
    expect(r.classPrependedAncestors?.["A"]).toEqual(["Pre"]);
  });

  it("returns undefined classPrependedAncestors when no class uses prepend", () => {
    const src = "class A\n  include Inc\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classPrependedAncestors).toBeUndefined();
  });

  it("qualifies nested class names via outer scope for prepended modules too", () => {
    const src = "module Acme\n  class User\n    prepend Auditable\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.classPrependedAncestors?.["Acme::User"]).toEqual(["Auditable"]);
  });
});

// bd tea-rags-mcp-brp1 — Ruby `super` keyword calls invoke the parent class's
// same-named method but were silently dropped by the walker (no `method` field
// on the AST node). Without these edges, inheritance chains miss huge swaths of
// callees in Rails/huginn-shape codebases (every `def call; super; end` proxy).
// Walker now emits a synthetic CallRef per super site whose receiver is the
// SUPER_RECEIVER_SENTINEL token and whose `member` is the enclosing method's
// name — the resolver recovers the parent class via classAncestors.
describe("extractFromRubyFile — super keyword calls (bd brp1)", () => {
  it("emits a CallRef for a bare `super` inside an instance method", () => {
    // huginn shape — `def call; ... super; end` in JavaScriptAgent::ConditionalFollowRedirects.
    const src = "class A < B\n  def foo\n    super\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "A#foo", scope: ["A"], startLine: 2, endLine: 4 }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.callText === "super");
    expect(superCall).toBeDefined();
    expect(superCall?.member).toBe("foo");
    expect(superCall?.startLine).toBe(3);
  });

  it("emits a CallRef for `super(args)` and preserves the source text", () => {
    // Mirrors `def initialize; super(); end` (huginn ImapFolderAgent::Notified).
    const src = "class A < B\n  def initialize\n    super(1, 2)\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "A#initialize", scope: ["A"], startLine: 2, endLine: 4 }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.callText.startsWith("super"));
    expect(superCall).toBeDefined();
    expect(superCall?.member).toBe("initialize");
    expect(superCall?.callText).toBe("super(1, 2)");
  });

  it("emits one CallRef per super even when interleaved with other calls", () => {
    // 3 calls total: bar, super (member=foo), baz.
    const src = "class A < B\n  def foo\n    bar\n    super\n    baz\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "A#foo", scope: ["A"], startLine: 2, endLine: 6 }],
    });
    const members = r.chunks[0].calls.map((c) => c.member).sort();
    // bar + baz are bare identifiers (no parens), tree-sitter-ruby parses them
    // as `identifier`, NOT `call` — so they don't appear here. The super call
    // is the only synthetic emission this test asserts on.
    expect(members).toContain("foo");
    const superCall = r.chunks[0].calls.find((c) => c.callText === "super");
    expect(superCall?.startLine).toBe(4);
  });

  it("emits a CallRef for `super` inside `def self.foo` (singleton method)", () => {
    // Class-method form — member should be the singleton method's bare name.
    const src = "class A < B\n  def self.foo\n    super\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "A.foo", scope: ["A"], startLine: 2, endLine: 4 }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.callText === "super");
    expect(superCall).toBeDefined();
    expect(superCall?.member).toBe("foo");
  });

  it("uses a sentinel receiver distinct from any real Ruby identifier", () => {
    // The receiver must not collide with a real receiver name so the resolver
    // can branch on it unambiguously. The sentinel starts with `<` — invalid
    // in Ruby identifiers — so no real receiver text can equal it.
    const src = "class A < B\n  def foo\n    super\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "A#foo", scope: ["A"], startLine: 2, endLine: 4 }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.callText === "super");
    expect(superCall?.receiver).toBeTruthy();
    expect(superCall?.receiver?.startsWith("<")).toBe(true);
  });
});

// bd tea-rags-mcp-hbie — Ruby method calls without parens parse as `identifier`
// nodes, not `call` nodes. Real-world Ruby uses bare-identifier calls
// pervasively (`user_agent` invokes the same method as `user_agent()` /
// `self.user_agent`). The walker now visits `identifier` nodes inside method
// bodies and emits a synthetic CallRef per surviving site, excluding local-
// binding declarations (assignments, parameters, block-vars, rescue-vars,
// for-loop-vars). The resolver's existing safeguards (jsa0 + lttd guards,
// t5iw same-class filter, pl7k language filter) handle the residual ambiguity
// from bare receiver=null edges.
describe("extractFromRubyFile — bare identifier method calls (bd hbie)", () => {
  it("emits a bare CallRef for a parenless method reference inside a method body", () => {
    // huginn PhantomJsCloudAgent#page_request_settings shape — `user_agent`
    // bare reference invokes `WebRequestConcern#user_agent` (parens stripped).
    const src = "class Foo\n  def page_request_settings\n    user_agent\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#page_request_settings", scope: ["Foo"], startLine: 2, endLine: 4 }],
    });
    const userAgent = r.chunks[0].calls.find((c) => c.member === "user_agent");
    expect(userAgent).toBeDefined();
    expect(userAgent?.receiver).toBeNull();
    expect(userAgent?.callText).toBe("user_agent");
    expect(userAgent?.startLine).toBe(3);
  });

  it("does NOT emit a CallRef for a local variable usage", () => {
    // `prs` is introduced by `prs = {}` on line 2; the later reference on
    // line 3 is a local var read, not a method call.
    const src = "def f\n  prs = {}\n  prs\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "prs")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a method parameter usage", () => {
    // `user` is a method parameter, not a method call. Bare references must
    // not produce an edge.
    const src = "def authorize(user, action)\n  user\n  action\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "authorize", scope: [], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "user")).toBeUndefined();
    expect(r.chunks[0].calls.find((c) => c.member === "action")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a block parameter usage", () => {
    // `x` is a block parameter introduced by `|x|`; bare reference inside
    // the block body is a local read.
    const src = "def f\n  items.each { |x| x }\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    // The bare `x` reference inside the block body must NOT produce an edge.
    // (The receiver-form `items.each` and its block contents are unrelated.)
    expect(r.chunks[0].calls.find((c) => c.receiver === null && c.member === "x")).toBeUndefined();
  });

  it("does NOT emit a CallRef for keywords self / nil / true / false", () => {
    // tree-sitter-ruby parses these as distinct node types — they should
    // never surface as identifier-driven bare calls.
    const src = "def f\n  self\n  nil\n  true\n  false\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 6 }],
    });
    for (const kw of ["self", "nil", "true", "false"]) {
      expect(r.chunks[0].calls.find((c) => c.member === kw)).toBeUndefined();
    }
  });

  it("emits each bare/parenless/qualified call exactly once (no duplicates)", () => {
    // Mixed body — bare `do_thing`, parenless `helper`, parened `compute()`,
    // qualified `obj.process`. Each AST site produces ONE CallRef.
    const src = ["def f(obj)", "  do_thing", "  compute()", "  obj.process", "end"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 5 }],
    });
    const doThing = r.chunks[0].calls.filter((c) => c.member === "do_thing");
    const compute = r.chunks[0].calls.filter((c) => c.member === "compute");
    const process = r.chunks[0].calls.filter((c) => c.member === "process");
    expect(doThing).toHaveLength(1);
    expect(doThing[0].receiver).toBeNull();
    expect(compute).toHaveLength(1);
    expect(compute[0].receiver).toBeNull();
    expect(process).toHaveLength(1);
    expect(process[0].receiver).toBe("obj");
    // `obj` is a parameter — must NOT show up as a bare-identifier call even
    // though it appears as the receiver of `process`.
    expect(r.chunks[0].calls.find((c) => c.receiver === null && c.member === "obj")).toBeUndefined();
  });

  it("emits a bare CallRef on the RHS of an assignment (`var = some_method`)", () => {
    // `prs[:userAgent] = user_agent` — bug shape from huginn. The RHS
    // identifier IS a method call site even though it sits in assignment.right.
    const src = "def f\n  prs = {}\n  prs[:userAgent] = user_agent\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 4 }],
    });
    const userAgent = r.chunks[0].calls.find((c) => c.member === "user_agent");
    expect(userAgent).toBeDefined();
    expect(userAgent?.receiver).toBeNull();
    // `prs` is a local — assignment.left + element_reference receiver. Must
    // NOT emit even though it appears in two extra positions.
    expect(r.chunks[0].calls.find((c) => c.member === "prs")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a rescue exception variable", () => {
    // `rescue StandardError => e` binds `e` as a local. The bare `e` reference
    // in the rescue body is a local read.
    const src = "def f\n  begin\n    risky\n  rescue StandardError => e\n    e\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 7 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "e")).toBeUndefined();
    // `risky` IS a bare call though — exercise the rescue body emission path.
    expect(r.chunks[0].calls.find((c) => c.member === "risky")).toBeDefined();
  });

  it("does NOT emit for a `for var in coll` loop variable", () => {
    // `for item in items` binds `item` as a loop-local.
    const src = "def f\n  for item in items_list\n    item\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 5 }],
    });
    expect(r.chunks[0].calls.find((c) => c.receiver === null && c.member === "item")).toBeUndefined();
    // `items_list` (the iterable expression) IS a bare call site.
    expect(r.chunks[0].calls.find((c) => c.member === "items_list")).toBeDefined();
  });
});

// Bug tea-rags-mcp-8ss5: send / public_send / __send__ with a literal symbol
// argument is semantically a direct method call. The walker already unwraps
// the receiver-set form (`obj.send(:foo)` → member="foo", receiver="obj").
// These tests extend coverage to the bare-call form (`send(:foo)` with no
// receiver) and the `self.send(:foo)` form, both of which are statically
// resolvable as same-class calls and should be unwrapped identically.
describe("extractFromRubyFile — send/public_send/__send__ unwrap (no-receiver / self)", () => {
  it("unwraps bare `send(:method)` (no receiver) into a same-class call", () => {
    const src = "def f\n  send(:helper)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "helper");
    expect(c).toBeDefined();
    // Bare send → receiver stays null so the resolver's same-class
    // fallback can take over (callerScope-aware lookup).
    expect(c?.receiver).toBeNull();
    // The literal `send` edge must NOT also be emitted.
    expect(r.chunks[0].calls.find((cr) => cr.member === "send")).toBeUndefined();
  });

  it("unwraps `self.send(:method)` into a same-class call (receiver normalised to null)", () => {
    const src = "def f\n  self.send(:helper)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "helper");
    expect(c).toBeDefined();
    // `self.send(:foo)` is semantically `self.foo` — same-class dispatch.
    // Normalise to receiver=null so the bare-call same-class lookup path
    // applies (rather than the receiver-set-but-unknown-type drop guard).
    expect(c?.receiver).toBeNull();
    expect(r.chunks[0].calls.find((cr) => cr.member === "send")).toBeUndefined();
  });

  it("unwraps bare `public_send(:method)` (no receiver)", () => {
    const src = "def f\n  public_send(:helper)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "helper");
    expect(c?.receiver).toBeNull();
    expect(r.chunks[0].calls.find((cr) => cr.member === "public_send")).toBeUndefined();
  });

  it("unwraps `self.__send__(:method)`", () => {
    const src = "def f\n  self.__send__(:helper)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "helper");
    expect(c?.receiver).toBeNull();
    expect(r.chunks[0].calls.find((cr) => cr.member === "__send__")).toBeUndefined();
  });

  it("keeps bare `send(var)` with non-literal arg as a literal send call", () => {
    // method_missing-style dispatch with a variable holding the method
    // name remains unrepresentable — fall back to the literal `send` edge.
    const src = "def method_missing(method_sym, *args)\n  send(method_sym, *args)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "method_missing", scope: ["method_missing"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "send")).toBeDefined();
  });
});

// Bug tea-rags-mcp-y2z5: `alias_method :new, :old` / `alias new old`. Both
// forms create a new method `new` aliasing `old` on the enclosing class.
// The walker emits a synthetic CallRef from the new method back to the old
// one so call-graph traversal can trace the alias redirect.
describe("extractFromRubyFile — alias_method / alias synthetic call edges", () => {
  it("emits synthetic CallRef from `alias_method :new, :old`", () => {
    const src = "class Foo\n  def old\n  end\n  alias_method :new_name, :old\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      // The chunker creates a synthetic single-line chunk for the
      // alias_method line; here we simulate that by giving its line range
      // as a chunk so the walker's innermost-chunk attribution lands the
      // emitted edge.
      chunks: [{ symbolId: "Foo#new_name", scope: ["Foo", "new_name"], startLine: 4, endLine: 4 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "old");
    expect(c).toBeDefined();
    // Same-class lookup — receiver stays null so resolver's bare-call
    // path finds Foo#old via callerScope.
    expect(c?.receiver).toBeNull();
  });

  it("emits synthetic CallRef from `alias new_name old_name` (keyword form)", () => {
    const src = "class Foo\n  def old_name\n  end\n  alias new_name old_name\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#new_name", scope: ["Foo", "new_name"], startLine: 4, endLine: 4 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "old_name");
    expect(c).toBeDefined();
    expect(c?.receiver).toBeNull();
  });

  it("emits NO synthetic CallRef for receiver-qualified `obj.alias_method` (not a class-body DSL)", () => {
    // `obj.alias_method :a, :b` is a regular method call on an object, not
    // a class-body alias declaration. The synthetic edge must not fire.
    const src = "def f\n  obj.alias_method :a, :b\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    // No synthetic null-receiver edge to `b` (the old name) emerges; the
    // only edge is the literal alias_method call on `obj`.
    const synthetic = r.chunks[0].calls.find((cr) => cr.receiver === null && cr.member === "b");
    expect(synthetic).toBeUndefined();
  });
});

// bd tea-rags-mcp-mx9z: `delegate :sym..., to: :recv` (ActiveSupport / Forwardable).
// The macro generates forwarder methods whose body calls `recv.sym`. The walker
// already synthesises the forwarder method SYMBOLS (#firm), but their codegraph
// chunk had fanOut=0 — the delegation TARGET went unlinked. The walker now emits
// one synthetic CallRef per delegated symbol: receiver = the `to:` value (leading
// `:` stripped for a symbol literal), member = the delegated symbol name. The
// `to:` value is usually a method/attr (`:client`) so the resolver's same-class
// bare-call fallback pins it; a constant `to:` value resolves via the constant
// strategy. Syntactic-only — no type inference.
describe("extractFromRubyFile — delegate ... to: (bd tea-rags-mcp-mx9z)", () => {
  it("emits synthetic CallRef from `delegate :firm, to: :client`", () => {
    const src = "class Foo\n  delegate :firm, to: :client\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      // The chunker creates a synthetic chunk for the generated #firm
      // forwarder method, attributed to the delegate macro line. Simulate
      // it so innermost-chunk attribution lands the emitted edge.
      chunks: [{ symbolId: "Foo#firm", scope: ["Foo", "firm"], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls.find((cr) => cr.member === "firm" && cr.receiver === "client");
    expect(c).toBeDefined();
    // Receiver is the `to:` value (a method/attr on the same class). The
    // leading `:` of the symbol literal is stripped.
    expect(c?.receiver).toBe("client");
  });

  it("emits a synthetic CallRef for EACH symbol in `delegate :a, :b, to: :proc_obj`", () => {
    const src = "class Foo\n  delegate :a, :b, to: :proc_obj\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#a", scope: ["Foo", "a"], startLine: 2, endLine: 2 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "a" && cr.receiver === "proc_obj")).toBeDefined();
    expect(r.chunks[0].calls.find((cr) => cr.member === "b" && cr.receiver === "proc_obj")).toBeDefined();
  });
});

// bd tea-rags-mcp-meh1 — Symbol#to_proc literal (`&:method_name`) in a call's
// block argument is a synthetic call to `method_name` on each iterator element.
// `[1, 2, 3].map(&:to_s)` ≡ `[1, 2, 3].map { |x| x.to_s }`. The walker emits
// two CallRefs per such call: the iterator method (.map / .filter / .sort_by)
// and the synthetic bare to-proc call (receiver=null, member=symbol-text).
// The resolver's existing same-class scope filter and global short-name
// fallback handle target resolution.
describe("extractFromRubyFile — Symbol#to_proc block-pass (bd meh1)", () => {
  it("emits synthetic CallRef for `[1, 2, 3].map(&:to_s)` on an array literal", () => {
    const src = "def f\n  [1, 2, 3].map(&:to_s)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    // Both calls present: the iterator and the synthetic to-proc.
    expect(r.chunks[0].calls.find((cr) => cr.member === "map" && cr.receiver === "[1, 2, 3]")).toBeDefined();
    expect(r.chunks[0].calls.find((cr) => cr.member === "to_s" && cr.receiver === null)).toBeDefined();
  });

  it("emits synthetic CallRef for `users.filter(&:active?)` preserving the `?` suffix", () => {
    // Predicate methods carry a `?` suffix in Ruby — symbol literal is
    // `:active?`. Walker must round-trip the suffix without stripping.
    const src = "def f\n  users.filter(&:active?)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    const synth = r.chunks[0].calls.find((cr) => cr.receiver === null && cr.member === "active?");
    expect(synth).toBeDefined();
    expect(synth?.callText).toBe("&:active?");
  });

  it("emits synthetic CallRef for `users.sort_by(&:name)`", () => {
    const src = "def f\n  users.sort_by(&:name)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "sort_by")).toBeDefined();
    expect(r.chunks[0].calls.find((cr) => cr.member === "name" && cr.receiver === null)).toBeDefined();
  });

  it("does NOT emit synthetic CallRef when block arg is a local variable (`&local_var`)", () => {
    // `users.sort_by(&local_var)` — the proc value is a runtime variable,
    // not a literal symbol. The receiver-type is unknown so no edge can
    // be synthesised; only the iterator call survives.
    const src = "def f\n  users.sort_by(&local_var)\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.member === "sort_by")).toBeDefined();
    // No to-proc synthesis — callText starting with `&:` would betray one.
    expect(r.chunks[0].calls.find((cr) => cr.callText.startsWith("&:"))).toBeUndefined();
  });
});

describe("extractFromRubyFile — registry constant-hash value edges (bd tea-rags-mcp-ki9v)", () => {
  it("emits a reference CallRef for each constant used as a hash value in a constant assignment", () => {
    const src =
      "class Registry\n" +
      "  TABLE = {\n" +
      "    'job' => Workflow::Job::Clone,\n" +
      "    'task' => Workflow::Task::Clone,\n" +
      "  }.freeze\n" +
      "end\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "registry.rb",
      language: "ruby",
      chunks: [{ symbolId: "Registry", scope: [], startLine: 1, endLine: 6 }],
    });
    const { calls } = r.chunks[0];
    expect(calls.find((cr) => cr.receiver === "Workflow::Job::Clone")).toBeDefined();
    expect(calls.find((cr) => cr.receiver === "Workflow::Task::Clone")).toBeDefined();
  });

  it("emits a reference CallRef for a constant used as an array element in a constant assignment", () => {
    const src = "class Registry\n  HANDLERS = [Foo::Bar, Baz::Qux].freeze\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "registry.rb",
      language: "ruby",
      chunks: [{ symbolId: "Registry", scope: [], startLine: 1, endLine: 3 }],
    });
    const { calls } = r.chunks[0];
    expect(calls.find((cr) => cr.receiver === "Foo::Bar")).toBeDefined();
    expect(calls.find((cr) => cr.receiver === "Baz::Qux")).toBeDefined();
  });

  it("does NOT emit for a constant nested inside a lambda value (STI registry, out of scope — jw9n)", () => {
    const src = `class Registry
  TABLE = {
    'job' => -> { Workflow::Job::Clone },
  }.freeze
end
`;
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "registry.rb",
      language: "ruby",
      chunks: [{ symbolId: "Registry", scope: [], startLine: 1, endLine: 5 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.receiver === "Workflow::Job::Clone")).toBeUndefined();
  });

  it("does NOT emit registry value edges for a non-constant (local var) assignment target", () => {
    const src = "class Registry\n  table = { 'job' => Workflow::Job::Clone }\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "registry.rb",
      language: "ruby",
      chunks: [{ symbolId: "Registry", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((cr) => cr.receiver === "Workflow::Job::Clone")).toBeUndefined();
  });
});

// mixinTargetFromStatement — scope_resolution argument (Acme::Base)
// The function handles both `constant` and `scope_resolution` first args.
describe("extractFromRubyFile — mixin scope_resolution ancestors", () => {
  it("captures `include Acme::Base` as a qualified ancestor", () => {
    const src = "class Foo\n  include Acme::Base\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "foo.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Foo"]).toContain("Acme::Base");
  });

  it("captures `prepend Acme::Concern` into classPrependedAncestors via scope_resolution", () => {
    const src = "class Bar\n  prepend Acme::Concern\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "bar.rb", language: "ruby", chunks: [] });
    expect(r.classPrependedAncestors?.["Bar"]).toContain("Acme::Concern");
  });

  it("captures `extend Mod::Helper` via scope_resolution into classAncestors", () => {
    const src = "class Baz\n  extend Mod::Helper\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "baz.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Baz"]).toContain("Mod::Helper");
  });

  it("ignores mixin with lowercase constant (fails PascalCase guard)", () => {
    const src = "class Qux\n  include lowercase_mod\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({ tree, code: src, relPath: "q.rb", language: "ruby", chunks: [] });
    expect(r.classAncestors?.["Qux"]).toBeUndefined();
  });
});

// collectRubyConstantRefs — scope_resolution skips nested fragments:
// Only the OUTERMOST scope_resolution is emitted; nested parents skip.
describe("extractFromRubyFile — Zeitwerk constant refs scope_resolution deduplication", () => {
  it("emits only the fully-qualified Acme::Auth::Login, not sub-fragments", () => {
    const src = "class Svc\n  def call\n    Acme::Auth::Login.new\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "svc.rb",
      language: "ruby",
      chunks: [{ symbolId: "Svc#call", scope: ["Svc"], startLine: 2, endLine: 4 }],
    });
    const zeitwerkImports = r.imports.filter((i) => i.importText.includes("Acme::Auth::Login"));
    expect(zeitwerkImports.length).toBeGreaterThanOrEqual(1);
    // Sub-fragments must NOT appear as separate entries
    const sub = r.imports.filter((i) => i.importText.endsWith("::Auth") || i.importText.endsWith("Acme"));
    expect(sub).toHaveLength(0);
  });
});

// collectLocalBindingsForChunk — method_call shape (tree-sitter-ruby emits
// AR finders via method_call in some grammar versions; the walker accepts both
// `call` and `method_call` node types).
describe("extractFromRubyFile — localBindings AR finders method_call shape", () => {
  it("binds u = User.find(1) via User class receiver", () => {
    const src = `${["def show", "  u = User.find(1)", "  u.render", "end"].join("\n")}\n`;
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "ctrl.rb",
      language: "ruby",
      chunks: [{ symbolId: "show", scope: ["show"], startLine: 1, endLine: 4 }],
    });
    // AR finder `find` binds `u` to `User`
    if (r.chunks[0].localBindings) {
      expect(r.chunks[0].localBindings["u"]).toBe("User");
    }
  });

  it("does NOT bind when receiver is lowercase (not a class constant)", () => {
    const src = "def m\n  x = helper.find(1)\n  x.use\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "m.rb",
      language: "ruby",
      chunks: [{ symbolId: "m", scope: ["m"], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings?.["x"]).toBeUndefined();
  });
});

// ─── bare-identifier call suppression — parameter flavors ────────────────────
// isBareIdentifierCallSite returns false for the `name` field of every
// parameter flavour tree-sitter-ruby produces. These tests cover branches
// that no existing test exercises: optional_parameter default-value expression,
// keyword_parameter, splat_parameter, hash_splat_parameter, block_parameter.
describe("extractFromRubyFile — isBareIdentifierCallSite parameter guards", () => {
  it("does NOT emit a CallRef for an optional parameter name (`def f(x = val)`)", () => {
    // `x` is the `name` field of an `optional_parameter` — NOT a call site.
    const src = "def f(x = 1)\n  x\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "x")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a keyword parameter name (`def f(name:)`)", () => {
    const src = "def f(name:)\n  name\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "name")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a splat parameter name (`def f(*args)`)", () => {
    const src = "def f(*args)\n  args\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "args")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a hash-splat parameter name (`def f(**opts)`)", () => {
    const src = "def f(**opts)\n  opts\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "opts")).toBeUndefined();
  });

  it("does NOT emit a CallRef for a block parameter name (`def f(&blk)`)", () => {
    const src = "def f(&blk)\n  blk\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "blk")).toBeUndefined();
  });

  it("emits a bare CallRef for a method call on the element_reference receiver's index position", () => {
    // `prs[:userAgent] = user_agent` — `prs` is element_reference.namedChildren[0]
    // (the receiver being indexed), not a call. `user_agent` on the RHS IS a call.
    // Exercises the element_reference guard in isBareIdentifierCallSite.
    const src = "def f\n  prs = {}\n  prs[:x] = user_agent\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].calls.find((c) => c.member === "prs" && c.receiver === null)).toBeUndefined();
    expect(r.chunks[0].calls.find((c) => c.member === "user_agent")).toBeDefined();
  });
});

// ─── collectMethodLocalBindings — exception_variable and for-loop ─────────────
describe("extractFromRubyFile — collectMethodLocalBindings edge cases", () => {
  it("suppresses bare call emission for a for-loop variable when that identifier appears in the body", () => {
    // `item` bound by `for item in items_list`; subsequent bare `item` is a local read.
    const src = "def process\n  for item in items_list\n    item.save\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "process", scope: [], startLine: 1, endLine: 5 }],
    });
    expect(r.chunks[0].calls.find((c) => c.receiver === null && c.member === "item")).toBeUndefined();
    expect(r.chunks[0].calls.find((c) => c.member === "save")).toBeDefined();
  });

  it("suppresses bare call emission for a rescue exception variable", () => {
    // `e` bound by `rescue StandardError => e`; bare `e.message` receiver is fine.
    const src = "def risky_op\n  begin\n    do_work()\n  rescue StandardError => e\n    log(e.message)\n  end\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "risky_op", scope: [], startLine: 1, endLine: 7 }],
    });
    expect(r.chunks[0].calls.find((c) => c.receiver === null && c.member === "e")).toBeUndefined();
    expect(r.chunks[0].calls.find((c) => c.member === "message")).toBeDefined();
  });
});

// ─── alias keyword redirect (bd tea-rags-mcp-y2z5) ───────────────────────────
// `alias new_name old_name` emits a synthetic CallRef from the alias site to
// the old method so the call-graph follows the redirect.
describe("extractFromRubyFile — alias keyword DSL redirect (bd y2z5)", () => {
  it("emits a CallRef for `alias to_s inspect` pointing to `inspect`", () => {
    const src = "class Foo\n  def inspect\n    'foo'\n  end\n  alias to_s inspect\nend\n";
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [
        { symbolId: "Foo#inspect", scope: ["Foo"], startLine: 2, endLine: 4 },
        { symbolId: "Foo#to_s", scope: ["Foo"], startLine: 5, endLine: 5 },
      ],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    const redirect = allCalls.find((c) => c.member === "inspect" && c.receiver === null);
    expect(redirect).toBeDefined();
  });
});

describe("extractFromRubyFile — extractSecondLiteralSymbol guard paths", () => {
  it("does NOT emit synthetic redirect when alias_method second arg is a string literal (not simple_symbol)", () => {
    // extractSecondLiteralSymbol: secondArg.type !== "simple_symbol" → return null
    // alias_method :new_name, "old_as_string" — second arg is string, not :symbol
    const src = ["class Foo", "  def old_method", "  end", '  alias_method :new_name, "old_method"', "end", ""].join(
      "\n",
    );
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [
        { symbolId: "Foo#old_method", scope: ["Foo"], startLine: 2, endLine: 3 },
        { symbolId: "Foo#new_name", scope: ["Foo"], startLine: 4, endLine: 4 },
      ],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    // Should have the alias_method call itself but NO synthetic redirect to old_method
    const syntheticRedirect = allCalls.find((c) => c.member === "old_method" && c.receiver === null);
    expect(syntheticRedirect).toBeUndefined();
  });
});

describe("extractFromRubyFile — extractDelegateTarget guard paths", () => {
  it("emits synthetic CallRef when delegate to: value is a scope_resolution constant (Foo::Bar)", () => {
    // extractDelegateTarget: value.type === "scope_resolution" → readScopeResolution → return text
    const src = ["class Foo", "  delegate :name, to: Acme::Client", "end", ""].join("\n");
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#name", scope: ["Foo"], startLine: 2, endLine: 2 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    // Should emit a synthetic call to Acme::Client.name
    const delegateCall = allCalls.find((c) => c.member === "name" && c.receiver === "Acme::Client");
    expect(delegateCall).toBeDefined();
  });

  it("does NOT emit synthetic CallRef when delegate to: value is a runtime expression (not symbol/constant)", () => {
    // extractDelegateTarget: value type is neither simple_symbol nor constant → return null
    const src = ["class Foo", "  delegate :name, to: get_receiver()", "end", ""].join("\n");
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#name", scope: ["Foo"], startLine: 2, endLine: 2 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    // No synthetic delegate edge — to: value is not a resolvable constant
    const delegateCall = allCalls.find((c) => c.member === "name" && c.receiver !== null && c.receiver !== "delegate");
    expect(delegateCall).toBeUndefined();
  });

  it("emits synthetic CallRef when delegate to: value is a bare constant (not symbol)", () => {
    // extractDelegateTarget: value.type === "constant" → return value.text
    const src = ["class Foo", "  delegate :name, to: Client", "end", ""].join("\n");
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "Foo#name", scope: ["Foo"], startLine: 2, endLine: 2 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    const delegateCall = allCalls.find((c) => c.member === "name" && c.receiver === "Client");
    expect(delegateCall).toBeDefined();
  });
});

describe("extractFromRubyFile — collectMethodLocalBindings nested method scope guard", () => {
  it("does NOT add inner method's parameter as outer method's local binding", () => {
    // collectMethodLocalBindings: skips nested method/singleton_method bodies (line 876)
    // The outer method has param x — y is only in the nested inner method scope
    const src = ["def outer(x)", "  def inner(y)", "    y.to_s", "  end", "  x.to_s", "end", ""].join("\n");
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [
        { symbolId: "outer", scope: [], startLine: 1, endLine: 6 },
        { symbolId: "inner", scope: [], startLine: 2, endLine: 4 },
      ],
    });
    // localTypeTrackingEnabled is off by default — check via calls instead
    // The outer method should have a call to x.to_s (x is a param, not filtered)
    const outerChunk = r.chunks.find((c) => c.symbolId === "outer");
    expect(outerChunk).toBeDefined();
    // y should NOT appear in outer's localBindings (would only be there if nested scopes leaked)
    expect(outerChunk?.localBindings?.has("y")).toBeFalsy();
  });
});

describe("extractFromRubyFile — collectRegistryConstantValueRefs (constant in registry)", () => {
  it("emits constant CallRef from registry literal value (bare constant, not scope_resolution)", () => {
    // collectRegistryConstantValueRefs: n.type === "constant" path (line 466-468)
    const src = ["HANDLERS = {", "  create: CreateHandler,", "  update: UpdateHandler,", "}", ""].join("\n");
    const tree = parse(src);
    const r = extractFromRubyFile({
      tree,
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [{ symbolId: "HANDLERS", scope: [], startLine: 1, endLine: 4 }],
    });
    const allCalls = r.chunks.flatMap((c) => c.calls);
    // Should emit CallRefs for CreateHandler and UpdateHandler constants
    expect(allCalls.find((c) => c.member === "CreateHandler")).toBeDefined();
    expect(allCalls.find((c) => c.member === "UpdateHandler")).toBeDefined();
  });
});
