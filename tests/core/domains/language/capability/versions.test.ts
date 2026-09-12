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
import { SHARED_LANGUAGE } from "../../../../../src/core/domains/language/kernel/capability.js";

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

  it("declares the shared * pseudo-language without a grammar axis", () => {
    const resolved = resolveLanguageCodeVersions(factory.capabilities(), () => "1.0.0");

    expect(resolved.get(SHARED_LANGUAGE)).toEqual({ chunking: 1, walker: 2, codegraphSchema: 1 });
    // `*` parses nothing of its own, so there is no grammar package to read —
    // and borrowing one language's would make the axis a lie for every other.
    expect(resolved.get(SHARED_LANGUAGE)?.grammar).toBeUndefined();
  });

  it("hands out a copy of the shared stamp, so a mutating caller cannot poison the next resolve", () => {
    const stamp = resolveLanguageCodeVersions(factory.capabilities(), () => undefined).get(SHARED_LANGUAGE);
    if (stamp) stamp.walker = 99;

    expect(resolveLanguageCodeVersions(factory.capabilities(), () => undefined).get(SHARED_LANGUAGE)?.walker).toBe(2);
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
      // `*` is not a language vertical. Its axes stand for sources that run
      // under every language at once, are pinned by their own test above, and
      // none of the per-language expectations below apply to them.
      if (language === SHARED_LANGUAGE) continue;
      // typescript walker 3: the wave-2 resolver additions (2a7e774e4), on top
      // of walker 2's oracle wave. python walker 2: bd tea-rags-mcp-9fgdi gave
      // `ImportRef` importedNames / importedBindings; python walker 3: bd
      // tea-rags-mcp-y4hro added the `classAncestors` channel; python walker 4:
      // E2 seam 5 (bd tea-rags-mcp-9fgdi) added the chunk-level
      // `callResultBindings` and the file-level `classFieldTypesByClassKey`;
      // python walker 5: bd tea-rags-mcp-w205u narrowed short-name resolution
      // to same-language, bare-callable, non-builtin candidates, so an index
      // built by walker 4 holds edges this one never emits; python walker 6: bd
      // tea-rags-mcp-4yvms persists `classFieldTypesByClassKey` +
      // `moduleReexports` in the pass-1 slice, so rows written by walker 5
      // carry neither and an incremental run on them still mis-resolves
      // cross-file fields and package re-exports; python walker 7: bd
      // tea-rags-mcp-11qqk scoped the import mapper's re-export memo to the RUN
      // rather than to the pooled symbol table, so rows written by walker 6 can
      // carry edges resolved through a re-export target that had already moved;
      // python walker 8: bd tea-rags-mcp-z99hp scoped the ancestor linearizer
      // the same way — by the identity of `classAncestors` rather than by the
      // pooled table — so rows written by walker 7 can carry edges resolved on
      // an MRO merged from a previous run's base lists.
      // ruby walker 2: bd
      // tea-rags-mcp-kumq2 routed every Ruby short-name lookup through the same
      // same-language filter, so an index built by walker 1 holds the
      // cross-language picks this one never emits. java walker 2: bd
      // tea-rags-mcp-f11nz gave the java walker the kernel's innermost-chunk
      // call attribution, so an index built by walker 1 holds a second copy of
      // every in-method call, emitted from the enclosing class chunk. rust
      // walker 2: the same bd tea-rags-mcp-f11nz change, where the duplicate
      // came from each enclosing impl / mod / trait chunk.
      // Every other language is still at its seed.
      const WALKER_BUMPED = new Map([
        ["typescript", 4],
        ["python", 8],
        ["ruby", 2],
        ["java", 2],
        ["rust", 2],
      ]);
      const expectedWalker = WALKER_BUMPED.get(language) ?? 1;
      const expectedCodegraph = NO_CALL_GRAPH.has(language) ? 1 : 2;
      expect(v.walker, `walker version for ${language}`).toBe(expectedWalker);
      expect(v.chunking, `chunking version for ${language}`).toBe(1);
      expect(v.codegraphSchema, `codegraph schema version for ${language}`).toBe(expectedCodegraph);
    }
  });
});
