/**
 * bd tea-rags-mcp-bjfa0 — a constant reached through a VALUE (`adapter::Client`)
 * names no type the walker knows: its namespace is whatever `adapter` holds at
 * runtime. Reading it as the bare `Client` typed a vendor client as the CRM
 * `::Client` model (taxdome `TransferBytesToPresignedTarget#build_api_client`),
 * and the naming lexicon then judged the method against the CRM model's names.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

function extract(lines: string[]) {
  const src = `${lines.join("\n")}\n`;
  const end = lines.length;
  // Through the COMPOSED walker: the identifier pass runs where production runs it.
  return new RubyLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "x.rb",
    language: "ruby",
    chunks: [
      { symbolId: "Transfer", scope: [], startLine: 1, endLine: end },
      { symbolId: "Transfer#build", scope: ["Transfer"], startLine: 2, endLine: end - 1 },
    ],
  });
}

describe("Ruby walker — a constant scoped by a value is no known type", () => {
  it("types no return from `value::Const.new`", () => {
    const r = extract(["class Transfer", "  def build(c)", "    adapter::Client.new(c)", "  end", "end"]);
    expect(r.functionReturnTypes?.build).toBeUndefined();
  });

  it("types no local bound to `value::Const.new`, by constructor or by binding", () => {
    const r = extract(["class Transfer", "  def build(c)", "    client = adapter::Client.new(c)", "  end", "end"]);
    const client = r.identifierDeclarations?.find((d) => d.name === "client");
    expect(client?.typeName).toBeUndefined();
    const chunk = r.chunks.find((c) => c.symbolId === "Transfer#build");
    expect(chunk?.localBindings?.client ?? []).toEqual([]);
  });

  // The RTA set over-approximates what is constructed: dropping the instantiation would prune dispatch edges.
  // bd 0qaht.65: recorded as an ordinary unanchored lexical site; the barrier resolves it.
  it("keeps the instantiation a value-scoped `.new` makes, as a lexical site, for dispatch pruning", () => {
    const r = extract(["class Transfer", "  def build(c)", "    described_class::Price.new(c)", "  end", "end"]);
    expect(r.rubyInstantiationSites).toEqual([{ name: "Price", nesting: ["Transfer"], rootAnchored: false }]);
  });

  it("resolves the value-scoped site at the barrier like any unanchored constant", () => {
    const [site] = extract(["class Transfer", "  def build(c)", "    described_class::Price.new(c)", "  end", "end"])
      .rubyInstantiationSites ?? [{ name: "", nesting: [], rootAnchored: false }];
    const resolve = new RubyLanguage().instantiationSiteResolver;
    expect(resolve?.(site, (fq) => fq === "Transfer::Price" || fq === "Price")).toBe("Transfer::Price");
    expect(resolve?.(site, (fq) => fq === "Price")).toBe("Price");
    expect(resolve?.(site, () => false)).toBe("Price");
  });

  it("still types a constant path of constants, root-anchored or not", () => {
    const r = extract([
      "class Transfer",
      "  def build(c)",
      "    client = Acme::Client.new(c)",
      "    root = ::Client.new(c)",
      "  end",
      "end",
    ]);
    const typeOf = (name: string) => r.identifierDeclarations?.find((d) => d.name === name)?.typeName;
    expect(typeOf("client")).toBe("Acme::Client");
    expect(typeOf("root")).toBe("::Client");
  });
});
