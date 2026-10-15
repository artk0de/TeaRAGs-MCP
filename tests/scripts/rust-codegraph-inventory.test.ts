import { pathToFileURL } from "node:url";

import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { buildRustSourceInventory } from "../../scripts/lib/rust-codegraph-inventory.js";

const workspaceRoot = "/workspace/rust";
const relPath = "src/lib.rs";

function inventory(source: string) {
  return buildRustSourceInventory({ source, relPath, workspaceRoot });
}

function rangeOf(source: string, text: string, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = source.indexOf(text, offset + 1);
  if (offset < 0) throw new Error(`missing fixture text: ${text}`);
  const position = (end: number) => {
    const lines = source.slice(0, end).split("\n");
    return { line: lines.length - 1, character: lines.at(-1)!.length };
  };
  return { start: position(offset), end: position(offset + text.length) };
}

function textAt(source: string, range: ReturnType<typeof rangeOf>) {
  const lines = source.split("\n");
  const start = lines.slice(0, range.start.line).reduce((sum, line) => sum + line.length + 1, 0);
  const end = lines.slice(0, range.end.line).reduce((sum, line) => sum + line.length + 1, 0);
  return source.slice(start + range.start.character, end + range.end.character);
}

describe("independent Rust source inventory", () => {
  it("pins native positions to UTF16 and distinguishes identical same-line calls", () => {
    const source = 'fn café() { let s = "🦀é"; café(); café(); }';
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const calls = parser.parse(source).rootNode.descendantsOfType("call_expression");
    expect(calls[0].startPosition.column).toBe(source.indexOf("café()", source.indexOf(";") + 1));
    expect(calls[0].startIndex).toBe(calls[0].startPosition.column);

    const result = inventory(source);
    expect(result.sites).toHaveLength(2);
    expect(result.sites.map((site) => site.expressionRange)).toEqual([
      rangeOf(source, "café()", 1),
      rangeOf(source, "café()", 2),
    ]);
    expect(result.sites.map((site) => textAt(source, site.tokenRange!))).toEqual(["café", "café"]);
    expect(new Set(result.sites.map((site) => site.key)).size).toBe(2);
    expect(result.symbols[0].selectionRange).toEqual(rangeOf(source, "café"));
    expect(inventory(source)).toEqual(result);
  });

  it("inventories every native call including callbacks, dereferences, closures and nested call-results", () => {
    const source = [
      "fn run(cb: fn(), value: Holder) {",
      "  cb(); (cb)(); (*cb)(); make()(); (|| nested())();",
      "  value.method::<u8>(); (value.callback)(); array[0]();",
      "}",
    ].join("\n");
    const result = inventory(source);
    expect(result.parseErrors).toEqual([]);
    expect(result.sites.map((site) => textAt(source, site.expressionRange))).toEqual([
      "cb()",
      "(cb)()",
      "(*cb)()",
      "make()",
      "make()()",
      "(|| nested())()",
      "nested()",
      "value.method::<u8>()",
      "(value.callback)()",
      "array[0]()",
    ]);
    const byText = (text: string) => result.sites.find((site) => textAt(source, site.expressionRange) === text)!;
    expect(byText("cb()").callee.uncertainty).toContain("valueOrFunction");
    expect(byText("(cb)()").tokenRange).toEqual(rangeOf(source, "cb", 2));
    expect(byText("value.method::<u8>()").callee).toMatchObject({ kind: "method", name: "method" });
    expect(byText("value.method::<u8>()").callee.uncertainty).toContain("dispatchUnknown");
    for (const [text, kind] of [
      ["(*cb)()", "dereference"],
      ["make()()", "callResult"],
      ["(|| nested())()", "closure"],
      ["(value.callback)()", "callableField"],
      ["array[0]()", "expression"],
    ]) {
      const site = byText(text);
      expect(site.callee.kind).toBe(kind);
      expect(site.tokenRange).toBeUndefined();
      expect(site.callee.name).toBeUndefined();
      expect(site.callee.unsupportedReason).toBeTypeOf("string");
    }
    expect(result).not.toHaveProperty("edges");
    expect(result.sites.every((site) => !("dispatch" in site))).toBe(true);
  });

  it("selects only grammar name tokens for generic UFCS and preserves qualified-value ambiguity", () => {
    const source = "fn run<T: Trait>() { module::f::<u8>(); <T as Trait>::make::<u8>(); T::make(); }";
    const result = inventory(source);
    expect(result.sites.map((site) => textAt(source, site.tokenRange!))).toEqual(["f", "make", "make"]);
    expect(result.sites[0].callee.uncertainty).toContain("qualifiedValueOrFunction");
    expect(result.sites[1].callee.uncertainty).toContain("traitDispatchUnknown");
    expect(result.sites[2].callee.uncertainty).toContain("qualifiedValueOrFunction");
  });

  it("keeps macro invocations separate without promoting token-tree calls or expansions", () => {
    const source =
      'macro_rules! emit { () => { hidden(); } } fn run() { emit!(argument()); ns::log!("🦀"); visible(); }';
    const result = inventory(source);
    expect(result.sites.map((site) => textAt(source, site.expressionRange))).toEqual(["visible()"]);
    expect(result.macros.map((site) => textAt(source, site.expressionRange))).toEqual([
      "emit!(argument())",
      'ns::log!("🦀")',
    ]);
    expect(result.macros.map((site) => textAt(source, site.tokenRange!))).toEqual(["emit", "log"]);
    expect(result.macros.every((site) => site.uncertainty.includes("expansionUnknown"))).toBe(true);
    expect(result.limitations).toContain("syntaxInventoryNotSemanticOracle");
    expect(result.limitations).toContain("macroExpansionNotInventoried");
  });

  it("derives inline module and function scopes with instance and associated declaration identities", () => {
    const source = [
      "fn root() {}",
      "mod outer { mod inner {",
      "  fn free() { fn nested() { target(); } nested(); }",
      "  struct Engine; impl Engine { fn run(&self) { target(); } fn new() -> Self { Self } }",
      "} }",
    ].join("\n");
    const result = inventory(source);
    expect(result.symbols.map((symbol) => symbol.symbolId)).toEqual([
      "root",
      "outer::inner::free",
      "outer::inner::free::nested",
      "outer::inner::Engine#run",
      "outer::inner::Engine.new",
    ]);
    expect(result.symbols.every((symbol) => symbol.uri === pathToFileURL(`${workspaceRoot}/${relPath}`).href)).toBe(
      true,
    );
    for (const symbol of result.symbols) {
      expect(textAt(source, symbol.selectionRange)).toBe(symbol.name);
      expect(textAt(source, symbol.range)).toContain(`fn ${symbol.name}`);
    }
    const nested = result.symbols.find((symbol) => symbol.name === "nested")!;
    expect(result.sites[0].ownerKey).toBe(nested.key);
    expect(result.symbols.every((symbol) => !symbol.declarationOnly && !symbol.traitDeclaration)).toBe(true);
  });

  it("records trait signatures and refuses exact identity for trait-impl or inherent namesake collisions", () => {
    const source = [
      "trait First { fn run(&self); fn new() -> Self; fn defaulted(&self) {} }",
      "trait Second { fn run(&self); }",
      "struct Engine;",
      "impl Engine { fn run(&self) {} fn unique() {} }",
      "impl First for Engine { fn run(&self) {} fn new() -> Self { Self } }",
      "impl Second for Engine { fn run(&self) {} }",
    ].join("\n");
    const result = inventory(source);
    expect(
      result.symbols.slice(0, 4).map((symbol) => [symbol.symbolId, symbol.declarationOnly, symbol.traitDeclaration]),
    ).toEqual([
      ["First#run", true, true],
      ["First.new", true, true],
      ["First#defaulted", false, true],
      ["Second#run", true, true],
    ]);
    const runs = result.symbols.filter((symbol) => symbol.candidateSymbolId === "Engine#run");
    expect(runs).toHaveLength(3);
    expect(runs.every((symbol) => symbol.symbolId === null && symbol.uncertainty.includes("ambiguousSymbolId"))).toBe(
      true,
    );
    expect(result.symbols.filter((symbol) => symbol.traitImpl).map((symbol) => symbol.traitName)).toEqual([
      "First",
      "First",
      "Second",
    ]);
    expect(result.symbols.filter((symbol) => symbol.traitImpl).every((symbol) => symbol.symbolId === null)).toBe(true);
    expect(result.symbols.find((symbol) => symbol.name === "unique")?.symbolId).toBe("Engine.unique");
  });

  it("keeps cfg source as unknown unless an explicit policy marks it inactive", () => {
    const source = '#[cfg(feature = "off")] mod gated { fn f() { target(); } } fn live() { live_call(); }';
    const result = inventory(source);
    expect(result.sites[0]).toMatchObject({
      provenance: "source",
      cfg: { status: "unknown", attributes: ['#[cfg(feature = "off")]'] },
    });
    expect(result.symbols[0]).toMatchObject({ provenance: "source", cfg: { status: "unknown" } });
    expect(result.sites[1].cfg.status).toBe("unconditional");
    const inactive = buildRustSourceInventory({ source, relPath, workspaceRoot, cfgPolicy: () => "inactive" });
    expect(inactive.sites[0].provenance).toBe("inactiveCfg");
    expect(inactive.symbols[0].provenance).toBe("inactiveCfg");
    expect(inactive.sites[1].provenance).toBe("source");
    expect(inactive.sites).toHaveLength(2);
  });

  it("preserves multiline UTF16 ranges and inner cfg_attr evidence without assuming activation", () => {
    const source = [
      '#![cfg_attr(feature = "x", cfg(unix))]',
      'mod gated { #![cfg(test)] fn f() { let s = "🦀"; target(\n  café()\n); } }',
    ].join("\n");
    const result = inventory(source);
    expect(result.parseErrors).toEqual([]);
    expect(result.sites.map((site) => site.expressionRange)).toEqual([
      rangeOf(source, "target(\n  café()\n)"),
      rangeOf(source, "café()"),
    ]);
    expect(result.sites[0].cfg).toEqual({
      status: "unknown",
      attributes: ['#![cfg_attr(feature = "x", cfg(unix))]', "#![cfg(test)]"],
    });
    expect(result.symbols[0].cfg).toEqual(result.sites[0].cfg);
    expect(result.sites.every((site) => site.provenance === "source")).toBe(true);
  });

  it("preserves uncertain declaration identity through qualified owners and nested trait implementation scopes", () => {
    const source = [
      "impl remote::Engine { fn run(self: Box<Self>) { target(); } }",
      "impl<T> Engine<T> { fn new() {} }",
      "impl First for Engine { fn run(&self) { fn nested() { target(); } } }",
    ].join("\n");
    const result = inventory(source);
    expect(result.parseErrors).toEqual([]);
    expect(result.symbols[0].symbolId).toBeNull();
    expect(result.symbols[0].uncertainty).toContain("unsupportedOwnerIdentity");
    expect(result.symbols[1].symbolId).toBe("Engine.new");
    expect(result.symbols[2].symbolId).toBeNull();
    expect(result.symbols[3].symbolId).toBeNull();
    expect(result.symbols[3].uncertainty).toContain("enclosingIdentityUnknown");
    expect(result.sites).toHaveLength(2);
  });

  it("reports malformed source while retaining native recovered calls and declarations", () => {
    const source = "fn intact() { before(); } fn broken() { after(); let value = ; }";
    const result = inventory(source);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors.every((error) => error.kind === "error" || error.kind === "missing")).toBe(true);
    expect(result.sites.map((site) => textAt(source, site.expressionRange))).toEqual(["before()", "after()"]);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["intact", "broken"]);
    expect(result.symbols[1].symbolId).toBeNull();
    expect(result.symbols[1].uncertainty).toContain("parseRecovery");
  });
});
