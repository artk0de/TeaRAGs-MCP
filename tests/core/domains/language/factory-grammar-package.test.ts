import { describe, expect, it } from "vitest";

import { GrammarPackageNotInstalledError, LanguageError } from "../../../../src/core/domains/language/errors.js";
import { LanguageFactory } from "../../../../src/core/domains/language/factory.js";

/**
 * bd tea-rags-mcp-e2pu7 (split from 7lnos item 2) — a checkout one
 * `npm install` short of its package.json met a missing tree-sitter grammar as
 * a raw ERR_MODULE_NOT_FOUND resolver trace. Owner decision: the language
 * factory owns the check — creating a provider whose grammar package is not
 * installed raises a typed, actionable error.
 */
describe("LanguageFactory — missing grammar package", () => {
  it("raises GrammarPackageNotInstalledError naming the package and the fix", () => {
    const factory = new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-swift" });

    let thrown: unknown;
    try {
      factory.create("swift");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GrammarPackageNotInstalledError);
    expect(thrown).toBeInstanceOf(LanguageError);
    const typed = thrown as GrammarPackageNotInstalledError;
    expect(typed.code).toBe("LANGUAGE_GRAMMAR_NOT_INSTALLED");
    expect(typed.message).toContain("tree-sitter-swift");
    expect(typed.message).toContain("swift");
    expect(`${typed.message} ${typed.hint}`).toContain("npm install");
  });

  it("does not cache a provider whose grammar was missing — a later create re-checks", () => {
    let installed = false;
    const factory = new LanguageFactory({ isGrammarPackageInstalled: () => installed });
    expect(() => factory.create("rust")).toThrow(GrammarPackageNotInstalledError);
    installed = true;
    expect(factory.create("rust").kernel.grammarPackage).toBe("tree-sitter-rust");
  });

  it("leaves other languages alone when one grammar is missing", () => {
    const factory = new LanguageFactory({ isGrammarPackageInstalled: (pkg) => pkg !== "tree-sitter-swift" });
    expect(() => factory.create("ruby")).not.toThrow();
  });

  it("never checks a doc-only language that has no grammar", () => {
    const checked: string[] = [];
    const factory = new LanguageFactory({
      isGrammarPackageInstalled: (pkg) => {
        checked.push(pkg);
        return false;
      },
    });
    expect(() => factory.create("markdown")).not.toThrow();
    expect(checked).toEqual([]);
  });

  it("creates every supported language with the real resolver in an installed checkout", () => {
    const factory = new LanguageFactory();
    for (const lang of factory.supported()) expect(() => factory.create(lang)).not.toThrow();
  });

  it("names the grammar package each kernel actually loads — derived from loadModule, not listed", async () => {
    const factory = new LanguageFactory();
    for (const lang of factory.supported()) {
      const { kernel } = factory.create(lang);
      const loaded = await kernel.loadModule();
      if (loaded === null) {
        expect(kernel.grammarPackage, `${lang} loads no grammar`).toBeUndefined();
        continue;
      }
      expect(kernel.grammarPackage, `${lang} loads a grammar but names no package`).toBeDefined();
      const named: unknown = await import(kernel.grammarPackage as string);
      expect(loaded, `${lang}: grammarPackage differs from what loadModule imports`).toBe(named);
    }
  });
});
