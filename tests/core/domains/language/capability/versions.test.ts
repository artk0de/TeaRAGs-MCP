/**
 * Per-language code versions (bd tea-rags-mcp-frwka).
 *
 * Three axes decide whether a language's indexed data is behind the code:
 * the upstream tree-sitter grammar, our own chunking/walker revision, and the
 * codegraph schema that language emits. The first is read from the installed
 * package; the rest are hand-bumped constants on the capability descriptor.
 */

import { describe, expect, it } from "vitest";

import { resolveLanguageCodeVersions } from "../../../../../src/core/domains/language/capability/versions.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

const factory = new LanguageFactory();

describe("resolveLanguageCodeVersions", () => {
  it("combines the descriptor's hand-bumped versions with the installed grammar version", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => "9.9.9");

    expect(versions.get("typescript")).toEqual({
      grammar: "9.9.9",
      chunking: expect.any(Number),
      walker: expect.any(Number),
      codegraphSchema: expect.any(Number),
    });
  });

  it("asks the reader for the language's declared grammar package", () => {
    const asked: string[] = [];
    resolveLanguageCodeVersions(factory.capabilities(), (pkg) => {
      asked.push(pkg);
      return undefined;
    });

    expect(asked).toContain("tree-sitter-typescript");
    expect(asked).toContain("tree-sitter-ruby");
  });

  it("omits grammar for a language that parses without a tree-sitter grammar", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => "9.9.9");

    expect(versions.get("markdown")?.grammar).toBeUndefined();
  });

  it("omits grammar when the package is not installed", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

    expect(versions.get("ruby")?.grammar).toBeUndefined();
    expect(versions.get("ruby")?.walker).toEqual(expect.any(Number));
  });

  it("declares versions for every supported language", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

    for (const language of factory.supported()) {
      expect(versions.get(language), `missing code versions for ${language}`).toBeDefined();
    }
  });

  it("reads the real installed grammar version by default", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities());

    expect(versions.get("ruby")?.grammar).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("seeded support versions", () => {
  const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

  it("seeds chunking at 1 everywhere, and bumps walker/codegraphSchema only where the code moved", () => {
    // codegraphSchema 2 on every language that EMITS method edges: bd
    // tea-rags-mcp-ex28m widened the edge primary key with source_rel_path, and
    // the rows the old key discarded can only come back by re-extraction.
    // markdown is doc-only — no call graph, so nothing of its was collapsed and
    // its axes stay put.
    const NO_CALL_GRAPH = new Set(["markdown"]);

    for (const [language, v] of versions) {
      const expectedWalker = language === "typescript" ? 2 : 1;
      const expectedCodegraph = NO_CALL_GRAPH.has(language) ? 1 : 2;
      expect(v.walker, `walker version for ${language}`).toBe(expectedWalker);
      expect(v.chunking, `chunking version for ${language}`).toBe(1);
      expect(v.codegraphSchema, `codegraph schema version for ${language}`).toBe(expectedCodegraph);
    }
  });
});
