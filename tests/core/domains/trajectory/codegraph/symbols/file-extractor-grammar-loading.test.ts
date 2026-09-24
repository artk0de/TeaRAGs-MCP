/**
 * bd tea-rags-mcp-e2pu7 — the codegraph extractor used to import every
 * tree-sitter grammar statically, so ONE missing grammar package killed the
 * whole module at link time with a raw ERR_MODULE_NOT_FOUND, before any
 * language factory check could run and for every language at once. Grammars
 * now load through the language kernel (`LanguageFactory.create(lang).kernel`),
 * per language and only when a file of that language is extracted.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ignore from "ignore";
import { afterAll, describe, expect, it } from "vitest";

import { GrammarPackageNotInstalledError, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  CODEGRAPH_LANGUAGES,
  CodegraphFileExtractor,
  loadCodegraphGrammar,
  loadCodegraphGrammarSync,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { CodegraphPhaseTimings } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/phase-timings.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

function extractorWith(languageFactory: LanguageFactory): CodegraphFileExtractor {
  return new CodegraphFileExtractor({
    languageFactory,
    collectSymbols,
    composer: new DefaultSymbolIdComposer(),
    runState: new CodegraphRunState(),
    phaseTimings: new CodegraphPhaseTimings(),
    exclusionFilter: ignore(),
  });
}

describe("CodegraphFileExtractor — grammar loading through the language kernel", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-grammar-loading-"));
  writeFileSync(join(root, "ledger.swift"), "class Ledger {\n  func post() { audit() }\n  func audit() {}\n}\n");
  writeFileSync(join(root, "pool.ts"), "export class Pool {\n  run(): void { helper(); }\n}\nfunction helper() {}\n");

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("raises the typed error for the language whose grammar package is missing", async () => {
    const extractor = extractorWith(
      new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-swift" }),
    );
    await expect(extractor.parse(root, "ledger.swift")).rejects.toBeInstanceOf(GrammarPackageNotInstalledError);
    await expect(extractor.extract(root, "ledger.swift")).rejects.toThrow(/tree-sitter-swift/);
  });

  it("still extracts every other language when one grammar is missing", async () => {
    const extractor = extractorWith(
      new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-swift" }),
    );
    await expect(extractor.parse(root, "ledger.swift")).rejects.toBeInstanceOf(GrammarPackageNotInstalledError);
    const extraction = await extractor.parse(root, "pool.ts");
    expect(extraction.language).toBe("typescript");
    expect(extraction.chunks.map((chunk) => chunk.symbolId)).toEqual(expect.arrayContaining(["Pool", "Pool#run"]));
  });

  it("extracts the language again once its grammar is installed — a failed load is not cached", async () => {
    let swiftInstalled = false;
    const extractor = extractorWith(
      new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-swift" || swiftInstalled }),
    );
    await expect(extractor.parse(root, "ledger.swift")).rejects.toBeInstanceOf(GrammarPackageNotInstalledError);
    swiftInstalled = true;
    const extraction = await extractor.parse(root, "ledger.swift");
    expect(extraction.chunks.map((chunk) => chunk.symbolId)).toEqual(expect.arrayContaining(["Ledger#post"]));
  });

  it("imports no tree-sitter grammar package statically — a missing one cannot break module load", () => {
    const source = readFileSync(
      new URL("../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']tree-sitter-[a-z]+["']/);
    expect(source).not.toMatch(/import\(\s*["']tree-sitter-[a-z]+["']\s*\)/);
  });
});

describe("loadCodegraphGrammar", () => {
  const factory = new LanguageFactory();

  // The grammar object each extension parsed with before the kernel owned the
  // load: the per-extension selection must survive the move, `.tsx` included.
  it("loads the tsx grammar for .tsx and the typescript grammar for the other TypeScript extensions", async () => {
    const ts = (await import("tree-sitter-typescript")).default as { typescript: unknown; tsx: unknown };
    expect(await loadCodegraphGrammar(factory, ".tsx")).toBe(ts.tsx);
    for (const ext of [".ts", ".mts", ".cts"]) expect(await loadCodegraphGrammar(factory, ext)).toBe(ts.typescript);
  });

  it("returns the same grammar object synchronously and asynchronously for every walked extension", async () => {
    for (const ext of Object.keys(CODEGRAPH_LANGUAGES)) {
      const loaded = await loadCodegraphGrammar(factory, ext);
      expect(loaded, ext).toBeDefined();
      expect(loadCodegraphGrammarSync(factory, ext), ext).toBe(loaded);
    }
  });

  it("raises the typed error synchronously too", () => {
    const missing = new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-rust" });
    expect(() => loadCodegraphGrammarSync(missing, ".rs")).toThrow(GrammarPackageNotInstalledError);
  });
});
