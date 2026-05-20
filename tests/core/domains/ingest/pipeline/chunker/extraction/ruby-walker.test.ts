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
} from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/ruby-walker.js";

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
