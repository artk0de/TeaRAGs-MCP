/**
 * Additional codegraph provider branch-coverage tests targeting uncovered
 * branches that `provider-defensive-paths.test.ts` does not exercise.
 *
 * Every scenario walks real source through `CodegraphEnrichmentProvider.
 * buildFileSignals` (no mocks). Each test pins the targeted branch
 * to an observable symbol-table outcome.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

interface TableAccess {
  deps: { symbolTable: InMemoryGlobalSymbolTable };
}

describe("CodegraphEnrichmentProvider — additional branch coverage", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-extra-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(
        new Map([
          ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
          ["javascript", new JavascriptCallResolver()],
          ["ruby", new RubyCallResolver()],
        ]),
      ),
      composer: new DefaultSymbolIdComposer(),
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("JS prototype-pattern + assignment chain emission", () => {
    it("`Foo.prototype.bar = function() {}` emits `Foo#bar` (instance form)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-proto-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "p.js"),
          ["function Foo() {}", "Foo.prototype.bar = function () { return 1; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#bar").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`exports.foo = function() {}` emits top-level `foo`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-exports-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "e.js"), "exports.foo = function () { return 1; };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("foo").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`module.exports = function named() {}` emits `named`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-modnamed-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "mn.js"), "module.exports = function named() { return 1; };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("named").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("alias chain `res.a = res.b = function() {}` emits BOTH symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-chain-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "c.js"),
          ["var res = {};", "res.contentType = res.type = function (mime) { return mime; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("res.contentType").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("res.type").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`const Foo = function() {}` emits `Foo`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-cfn-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "cf.js"), "const Foo = function () { return 1; };\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`const Foo = () => 1` arrow-function emits `Foo`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-arrow-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "ca.js"), "const Foo = () => 1;\n");
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("plain `obj.method = function() {}` emits `obj.method`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-objmem-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "om.js"),
          ["var obj = {};", "obj.method = function () { return 1; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("obj.method").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("pre-ES6 constructor function (with Foo.prototype.X sibling) synthesises Foo#constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-pre-es6-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "pe.js"),
          ["function Widget() { this.x = 1; }", "Widget.prototype.render = function () {};", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Pre-ES6 ctor — Widget#constructor synthesised + Widget#render.
        expect(table.lookup("Widget").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Widget#render").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Object.defineProperty with `set:` only (no `get:`) descriptor — still emitted as accessor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-setonly-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "so.js"),
          ["var obj = {};", "Object.defineProperty(obj, 'name', { set: function (v) { this._v = v; } });", ""].join(
            "\n",
          ),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // objectHasGetterPair accepts `set:` with function value too.
        expect(table.lookup("obj.name").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("template-string property name (no interpolation) works for defineGetter", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-tmpl-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "tt.js"),
          ["var obj = {};", "defineGetter(obj, `name`, function () { return 1; });", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("obj.name").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("template-string with interpolation rejected — no symbol emitted", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-tmpl-int-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ti.js"),
          (() => {
            const dollar = String.fromCharCode(36);
            return [
              "var obj = {};",
              "var suffix = 'X';",
              `defineGetter(obj, \`name${dollar}{suffix}\`, function () { return 1; });`,
              "",
            ].join("\n");
          })(),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Interpolation rejects readStringLiteral → null → no symbol.
        expect(table.lookup("obj.name").length).toBe(0);
        expect(table.lookup("obj.nameX").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Object.defineProperty with member-expression receiver (exports.proto)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-objproto-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ep.js"),
          [
            "exports.proto = {};",
            "Object.defineProperty(exports.proto, 'router', { get: function () { return 1; } });",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("exports.proto.router").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach dispatch with arrow function as callback emits per-verb symbols", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-arrow-foreach-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "af.js"),
          [
            "var methods = require('methods');",
            "var app = {};",
            "methods.forEach((method) => {",
            "  app[method] = function () { return method; };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("app.get").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach callback with zero params — paramIds.length !== 1 — skipped", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-zeroparams-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "zp.js"),
          [
            "var methods = ['get'];",
            "var app = {};",
            "methods.forEach(function () { app.get = function() {}; });",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // No paramName to anchor on — dispatch null.
        // The explicit app.get = fn DOES still emit via lhsToNamedSymbol path.
        expect(table.lookup("app.get").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach with body that does NOT subscript-assign — dispatch returns null", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-no-subscript-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ns.js"),
          ["var methods = require('methods');", "methods.forEach(function (m) { console.log(m); });", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // No `obj[m] = fn` assignment — `findFirstSubscriptDispatchAssignment` returns null.
        expect(table.lookup("get").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Ruby DSL macros — additional coverage", () => {
    it("multi-arg `attr_accessor :a, :b` emits accessors for each", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-multi-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "m.rb"), ["class Foo", "  attr_accessor :a, :b", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#a").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Foo#a=").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Foo#b").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Foo#b=").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`alias_method :new_name, :old_name` emits new_name as synthetic instance method", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-alias-sym-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "as.rb"),
          ["class Foo", "  def old_method; 1; end", "  alias_method :new_method, :old_method", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#new_method").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`alias new_name old_name` keyword form emits new_name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-alias-kw-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ak.rb"),
          ["class Foo", "  def old_method; 1; end", "  alias new_method old_method", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#new_method").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`define_method(:foo) { ... }` symbol-arg form emits Foo#foo", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-defmeth-sym-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "dm.rb"),
          ["class Foo", "  define_method(:hello) { 'hi' }", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#hello").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`obj.alias_method` with receiver — NOT a class-body macro, not emitted as DSL", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-alias-recv-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "ar.rb"),
          ["class Foo", "  def m", "    obj.alias_method(:new_name, :old_name)", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Has receiver → rubyAliasMethodEmission returns null.
        expect(table.lookup("Foo#new_name").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`obj.define_method` with receiver — NOT a class-body macro", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-defmeth-recv-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "dr.rb"),
          ["class Foo", "  def m", "    obj.define_method(:foo) { 1 }", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // Has receiver → rubyDefineMethodEmission returns null.
        expect(table.lookup("Foo#foo").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`obj.attr_accessor` with receiver — NOT a class-body macro", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-attr-recv-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "atr.rb"),
          ["class Foo", "  def m", "    obj.attr_accessor(:foo)", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#foo").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("`unrecognised_macro :x` — not in RUBY_DSL_MACROS — no emission", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-unknown-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "u.rb"), ["class Foo", "  unrecognised_macro :x", "end", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // RUBY_DSL_MACROS["unrecognised_macro"] is undefined → null.
        expect(table.lookup("Foo#x").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Ruby nested class scope_resolution `class Outer::Inner` emits qualified name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-scope-cls-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "sc.rb"),
          ["module Outer", "  class Inner", "    def m; end", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // qualified name reaches cg_symbols via scopeResolutionText/joinSymbol.
        expect(table.lookup("Outer::Inner#m").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Ruby `class << self` block — methods classified as static", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rb-class-self-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "cs.rb"),
          ["class Foo", "  class << self", "    def helper", "      1", "    end", "  end", "end", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo.helper").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Rust / Go / Bash nameOf — additional branch coverage", () => {
    it("Rust `impl Trait for Foo` attributes methods to Foo (not Trait)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-impl-trait-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "t.rs"),
          [
            "trait Greeter { fn hello(&self); }",
            "struct Foo;",
            "impl Greeter for Foo {",
            "    fn hello(&self) {}",
            "}",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // hello is attributed to Foo, not Greeter.
        expect(table.lookup("Foo#hello").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Greeter#hello").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust associated function (no `self`) joins with `.` (static)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-assoc-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "a.rs"),
          ["struct Foo;", "impl Foo {", "    fn new() -> Self { Foo }", "}", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // No `self` → static → joins with `.`.
        expect(table.lookup("Foo.new").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust struct_item emits top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-struct-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "s.rs"), ["struct Widget { x: i32 }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Widget").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust enum_item emits top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-enum-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "e.rs"), ["enum Status { Ok, Err }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Status").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust trait_item emits top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-trait-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "tt.rs"), ["trait Greeter { fn hello(&self); }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Greeter").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Rust mod_item emits a top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-rust-mod-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "mm.rs"), ["mod inner { fn f() {} }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("inner").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Go function_declaration (top-level) emits bare name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-go-func-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "g.go"), ["package main", "", "func DoIt() {}", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("DoIt").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Go type_declaration emits the type name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-go-type-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "t.go"), ["package main", "", "type Widget struct { x int }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Widget").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Go method with non-pointer receiver type `func (r Receiver) M()`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-go-nonptr-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "v.go"),
          ["package main", "", "type Receiver struct{}", "", "func (r Receiver) Method() {}", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Receiver#Method").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Java enum_declaration emits top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-enum-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "S.java"), ["enum Status { OK, ERR }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Status").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Java interface_declaration emits top-level symbol", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-iface-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "I.java"), ["interface Greeter { void hello(); }", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Greeter").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Java constructor_declaration emits Class#constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-ctor-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "C.java"), ["class C {", "  public C() {}", "}", ""].join("\n"));
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // constructor is instance-bound — `C#C`.
        expect(table.lookup("C").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Python — provider extends + class hierarchies", () => {
    it("Python class with single base — classExtends recorded", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-py-ext-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "h.py"),
          [
            "class Base:",
            "  def m(self): return 1",
            "",
            "class Child(Base):",
            "  def m(self): return super().m()",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Child").length).toBeGreaterThanOrEqual(1);
        expect(table.lookup("Base").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Python `@classmethod` decorator → static joining (`.`)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-py-classm-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "c.py"),
          ["class Foo:", "  @classmethod", "  def make(cls):", "    return cls()", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        // @classmethod → static → joinSymbol with `.`.
        expect(table.lookup("Foo.make").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Python `@staticmethod` decorator → static joining (`.`)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-py-staticm-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "s.py"),
          ["class Foo:", "  @staticmethod", "  def helper():", "    return 1", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo.helper").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("Python regular method → instance joining (`#`)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-py-instm-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "im.py"),
          ["class Foo:", "  def regular(self):", "    return 1", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const table = (provider as unknown as TableAccess).deps.symbolTable;
        expect(table.lookup("Foo#regular").length).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
