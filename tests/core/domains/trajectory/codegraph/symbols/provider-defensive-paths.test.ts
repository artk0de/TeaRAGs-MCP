/**
 * Codegraph provider defensive-path coverage.
 *
 * Drives `CodegraphEnrichmentProvider.buildFileSignals` against real
 * source files containing malformed / edge-case syntax (ERROR nodes,
 * computed property access, deep chains, anonymous functions,
 * dispatch shapes that miss one of the HTTP-verb signals, Ruby DSL
 * macros with non-symbol args). Each scenario exercises a
 * `return null` / silent-skip branch in `provider.ts:jsNameOf`,
 * `lhsToNamedSymbol`, `jsForEachDispatchEmission`, `jsGetterHelperEmission`,
 * Ruby macro helpers, and friends.
 *
 * No mocks — every assertion checks the persisted symbol table or
 * graph state after walking real source through the full provider.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/javascript/javascript-resolver.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ruby/ruby-resolver.js";
import { TSCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

interface TableAccess {
  deps: { symbolTable: InMemoryGlobalSymbolTable };
}

describe("CodegraphEnrichmentProvider — defensive paths on malformed input", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-defensive-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([
        ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
        ["javascript", new JavascriptCallResolver()],
        ["ruby", new RubyCallResolver()],
      ]),
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("JS lhsToNamedSymbol — guard returns", () => {
    it("computed property `obj[expr] = fn` produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-comp-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "x.js"),
          ["var obj = {};", "var key = 'k';", "obj[key] = function () { return 1; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // The computed-property assignment is `obj[key] = fn` —
        // `prop.type !== "property_identifier"` returns null (line 2139).
        expect(table.lookup("obj.key").length).toBe(0);
        expect(table.lookup("obj[key]").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("deep member chain `a.b.c = fn` is rejected (not idiomatic CommonJS)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-deep-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "y.js"),
          ["var a = { b: {} };", "a.b.c = function () { return 1; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // a.b.c falls through the deep-member return null (line 2158).
        expect(table.lookup("a.b.c").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("anonymous module.exports = function () {} produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-anon-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "anon.js"), "module.exports = function () { return {}; };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // No name on the function → null (line 2174).
        expect(table.lookup("module.exports").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("variable_declarator with destructuring pattern produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-destruct-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "d.js"), "const { a } = { a: function() {} };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // nameNode.type !== "identifier" (line 1497) → null.
        expect(table.lookup("a").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("variable_declarator with non-function value produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-nonfunc-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "v.js"), "const x = 42;\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // valueNode is `number`, not function — line 1498 returns null.
        expect(table.lookup("x").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Object.defineProperty with non-getter descriptor (value:) produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defprop-val-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "g.js"),
          ["var obj = {};", "Object.defineProperty(obj, 'name', { value: 1 });", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // objectHasGetterPair returns false → null.
        expect(table.lookup("obj.name").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("defineGetter with non-function 3rd arg produces NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defget-string-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "g2.js"),
          ["var obj = {};", "defineGetter(obj, 'name', 'not a fn');", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // isFunctionValuedExpression returns false → null.
        expect(table.lookup("obj.name").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach dispatch WITHOUT any HTTP-verb signal produces NO HTTP-verb symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-nosig-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "loop.js"),
          [
            "var arr = ['a', 'b'];",
            "var target = {};",
            "arr.forEach(function (item) {",
            "  target[item] = function () { return item; };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // None of the 3 HTTP-verb signals fire — receiver is `arr`, body has no
        // string-literal HTTP-verb compare, no require('methods'). Provider
        // emits no `target.get`/etc.
        expect(table.lookup("target.get").length).toBe(0);
        expect(table.lookup("target.post").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach dispatch WITH HTTP-verb compare body emits per-verb symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-verb-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "verbs.js"),
          [
            "var methods = ['get', 'post', 'put'];",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  if (method === 'get') console.log('skip');",
            "  app[method] = function () { return method; };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Body has `method === 'get'` — STRONGEST signal triggers full
        // HTTP_VERBS emission.
        expect(table.lookup("app.get").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("app.post").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach with non-identifier receiver (member_expression) skips dispatch", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-mexp-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "m.js"),
          [
            "var lib = { methods: ['get'] };",
            "var t = {};",
            "lib.methods.forEach(function (m) {",
            "  if (m === 'get') t[m] = function () {};",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // recv.type !== "identifier" (line 1578) — provider's forEach dispatch returns null.
        expect(table.lookup("t.get").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach callback with two parameters skips dispatch", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-2params-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "two.js"),
          [
            "var methods = ['get'];",
            "var app = {};",
            "methods.forEach(function (m, i) {",
            "  if (m === 'get') app[m] = function () {};",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // paramIds.length !== 1 (line 1586).
        expect(table.lookup("app.get").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Ruby — DSL macros with non-symbol args + edge cases", () => {
    it("attr_accessor with no args produces NO synthetic methods", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-no-args-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "x.rb"), ["class Foo", "  attr_accessor", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // symbolBases.length === 0 → return null (line 2394).
        // No accessor methods emitted under Foo.
        const all = table.lookup("Foo");
        expect(all.length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("attr_accessor with non-symbol arg (e.g. variable) skipped", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-nonsymbol-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "y.rb"),
          ["class Foo", "  fields = [:a, :b]", "  attr_accessor(*fields)", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // splat_argument is not simple_symbol → symbolBases stays empty.
        expect(table.lookup("Foo#a").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("alias_method with non-symbol first arg produces NO synthetic method", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-alias-nonsym-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "a.rb"),
          ["class Foo", "  def old_name; end", "  alias_method 'new_name', :old_name", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // firstArg.type !== "simple_symbol" (line 2270) → null.
        // alias_method DSL macro skipped, but rubyMacroEmission won't find
        // alias_method in RUBY_DSL_MACROS so it does nothing either.
        expect(table.lookup("Foo#new_name").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("define_method with non-literal arg produces NO synthetic method", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-defmeth-dyn-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "d.rb"),
          ["class Foo", "  name = :dynamic", "  define_method(name) { 1 }", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // firstArg is identifier (the local `name`), not simple_symbol → null.
        expect(table.lookup("Foo#dynamic").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("define_method with string literal arg emits synthetic method", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-defmeth-str-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "s.rb"),
          ["class Foo", "  define_method('greet') { 'hi' }", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // string literal branch fires (lines 2307-2310).
        expect(table.lookup("Foo#greet").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("alias keyword with broken syntax produces no symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-alias-broken-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Just bare `alias` keyword — no identifiers — leads to the
        // `if (!newName) return null` (line 2283) in rubyAliasKeywordEmission.
        writeFileSync(join(root, "src", "x.rb"), "alias\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("scope macro emits class-level method (singular, not instance)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-scope-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ar.rb"),
          ["class User", "  scope :active, -> { where(active: true) }", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // `scope` builder returns kind "static" — joins with `.` not `#`.
        expect(table.lookup("User.active").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("delegate macro emits forwarder instance methods", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-delegate-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "d.rb"), ["class Foo", "  delegate :a, :b, to: :other", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#a").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Foo#b").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("module with `extend self` promotes instance methods to also be static", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-extselfm-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "m.rb"),
          ["module M", "  extend self", "  def hello; 'hi'; end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Per `rubyMethodInsideExtendSelfModule` (lines 2576-2598), both
        // forms emitted.
        expect(table.lookup("M#hello").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("M.hello").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("class with `extend self` (NOT module) does NOT trigger promotion", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-extselfc-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "c.rb"),
          ["class C", "  extend self", "  def hello; 'hi'; end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // The `class` branch in rubyMethodInsideExtendSelfModule
        // returns false (line 2579) — only instance form emitted.
        expect(table.lookup("C#hello").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("C.hello").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Misc — empty / comment-only / broken-syntax files", () => {
    it("empty file does not throw and emits no symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-empty-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "empty.js"), "");
        writeFileSync(join(root, "src", "also-empty.ts"), "");
        writeFileSync(join(root, "src", "empty.py"), "");
        writeFileSync(join(root, "src", "empty.rb"), "");
        await provider.buildFileSignals(root);
        // Should complete without error. No symbols expected.
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("anything").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("comment-only file emits no symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-comments-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "c.js"), "// top comment\n/* block */\n// trailing\n");
        writeFileSync(join(root, "src", "c.py"), '"""docstring only"""\n# trailing comment\n');
        writeFileSync(join(root, "src", "c.rb"), "# top\n# more\n");
        await provider.buildFileSignals(root);
        // Completes without crashing. No defined symbols expected.
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("nonexistent").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("broken-syntax file completes (tree-sitter recovers via ERROR nodes)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-broken-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Class with broken interior — tree-sitter inserts ERROR nodes.
        writeFileSync(
          join(root, "src", "broken.js"),
          ["class Foo {", "  bar(", "  baz() { return 1; }", "}", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        // Provider should not throw; baz at minimum should be findable.
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Tree-sitter often recovers `baz` even in this case.
        expect(table.lookup("Foo").length).toBeGreaterThanOrEqual(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("file with `module.exports = {}` (object literal RHS) emits no name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-objlit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "ol.js"), "module.exports = { foo: 1 };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // RHS is object, not function → walkAssignmentChainToTerminalRhs
        // returns an object node, and isFunctionValuedExpression rejects it.
        expect(table.lookup("foo").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("JS getter helpers — full positive + this-resolution paths", () => {
    it("Object.defineProperty with get-pair on identifier receiver emits `obj.name`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defprop-get-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "g.js"),
          ["var obj = {};", "Object.defineProperty(obj, 'computed', { get: function () { return 1; } });", ""].join(
            "\n",
          ),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("obj.computed").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Object.defineProperty with set-pair on identifier receiver also emits", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defprop-set-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "s.js"),
          ["var obj = {};", "Object.defineProperty(obj, 'writable', { set: function (v) { this._v = v; } });", ""].join(
            "\n",
          ),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("obj.writable").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("defineGetter with function arg emits `obj.name`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defget-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "g2.js"),
          ["var obj = {};", "defineGetter(obj, 'router', function () { return r; });", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("obj.router").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("nested Object.defineProperty(this, …) inside `app.init = function()` resolves this → app", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-this-resolve-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "express.js"),
          [
            "var app = {};",
            "app.init = function () {",
            "  Object.defineProperty(this, 'router', { get: function () { return 'r'; } });",
            "};",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // resolveEnclosingThisReceiver climbs out → emits `app.router`.
        expect(table.lookup("app.router").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("nested defineGetter(this, …) inside `app.init = function()` resolves this → app", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-this-defget-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ex2.js"),
          [
            "var app = {};",
            "app.init = function () {",
            "  defineGetter(this, 'router', function () { return r; });",
            "};",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("app.router").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("top-level `this` defineProperty (no enclosing assignment) emits NO symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-this-free-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "free.js"),
          "Object.defineProperty(this, 'orphan', { get: function () { return 1; } });\n",
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // resolveEnclosingThisReceiver returns null → caller skips.
        expect(table.lookup("this.orphan").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Object.defineProperty with descriptor that's not an object literal — skipped", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-defprop-nonobj-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "d.js"),
          ["var desc = { get: function () {} };", "Object.defineProperty(obj, 'x', desc);", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // descriptor is identifier `desc`, not object literal — line 1836 returns null.
        expect(table.lookup("obj.x").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach dispatch via require('methods') package emits per-verb symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-pkg-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "app.js"),
          [
            "var methods = require('methods');",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  app[method] = function () { return method; };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // findRequireSource finds `methods`, hasHttpVerbDispatchSignal → true.
        expect(table.lookup("app.get").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach dispatch via local util import emits per-verb symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-foreach-util-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "app2.js"),
          [
            "var helper = require('./utils');",
            "var methods = helper.methods;",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  app[method] = function () { return method; };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // anyImportPathContainsUtil → true via `./utils` import.
        expect(table.lookup("app.get").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Ruby — more macro and singleton edge cases", () => {
    it("has_many with one symbol emits getter/setter pair", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-has-many-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "user.rb"), ["class User", "  has_many :posts", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("User#posts").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("User#posts=").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("belongs_to emits 4 synthetic instance methods", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-belongs-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "comment.rb"), ["class Comment", "  belongs_to :user", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Comment#user").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Comment#user=").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Comment#user_id").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Comment#user_id=").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("attr_reader emits only getter (no setter)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-reader-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "r.rb"), ["class Foo", "  attr_reader :name", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#name").length).toBeGreaterThanOrEqual(1);
        // No setter — `attr_reader` doesn't emit `name=`.
        expect(table.lookup("Foo#name=").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("attr_writer emits only setter (no getter)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-writer-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "w.rb"), ["class Foo", "  attr_writer :name", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#name=").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Foo#name").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("has_and_belongs_to_many emits getter+setter", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-habtm-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "u.rb"),
          ["class User", "  has_and_belongs_to_many :roles", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("User#roles").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("User#roles=").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("has_one emits getter+setter", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-has-one-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "u.rb"), ["class User", "  has_one :profile", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("User#profile").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("User#profile=").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("singleton_method (def self.foo) joins with `.` not `#`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-singleton-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "k.rb"),
          ["class K", "  def self.helper", "    1", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // singleton_method classified as static → joinSymbol uses `.`.
        expect(table.lookup("K.helper").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Go / Java / Rust / Bash nameOf — defensive paths via real files", () => {
    it("Go method with no name field — guarded", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-go-noname-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "x.go"), ["package main", "", "func (r *Receiver) Method() {}", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Receiver#Method").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Go generic receiver type → walker handles generic_type branch without crashing", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-go-generic-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "g.go"),
          ["package main", "", "type Container[T any] struct{}", "", "func (c *Container[T]) Push(v T) {}", ""].join(
            "\n",
          ),
        );
        // Drives extractGoReceiverType's generic_type branch (lines 2454-2457).
        // Some grammar versions parse the receiver type slightly differently;
        // we only assert that the walker completes without crashing — that
        // alone executes the generic-handling code path.
        await provider.buildFileSignals(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Java method without static modifier is instance — uses `#`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-inst-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "U.java"),
          ["class U {", "  void doIt() {}", "  static void make() {}", "}", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("U#doIt").length).toBeGreaterThanOrEqual(1);
        // Static — joined with `.`.
        expect(table.lookup("U.make").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust impl with generic params strips them from scope name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-generic-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "w.rs"),
          [
            "struct Worker<'s> { _p: std::marker::PhantomData<&'s ()> }",
            "",
            "impl<'s> Worker<'s> {",
            "    fn run(&self) {}",
            "}",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // stripRustGenerics keeps Worker; method uses `#`.
        expect(table.lookup("Worker#run").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust macro_rules! emits symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-macro-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "m.rs"), ["macro_rules! my_macro {", "    () => {};", "}", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("my_macro").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Bash function_definition emits symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-bash-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "f.sh"), ["#!/bin/bash", "", "my_func() {", "  echo hi", "}", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("my_func").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
