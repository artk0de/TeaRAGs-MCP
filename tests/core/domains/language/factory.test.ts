import { describe, expect, it } from "vitest";

import { LanguageFactoryImpl } from "../../../../src/core/domains/language/factory.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";
import { GoLanguage } from "../../../../src/core/domains/language/go/index.js";
import { JavaLanguage } from "../../../../src/core/domains/language/java/index.js";
import { JavaScriptLanguage } from "../../../../src/core/domains/language/javascript/index.js";
import { PythonLanguage } from "../../../../src/core/domains/language/python/index.js";
import { RubyLanguage } from "../../../../src/core/domains/language/ruby/index.js";
import { RustLanguage } from "../../../../src/core/domains/language/rust/index.js";
import { BashLanguage } from "../../../../src/core/domains/language/bash/index.js";
import { MarkdownLanguage } from "../../../../src/core/domains/language/markdown/index.js";
import { TypeScriptLanguage } from "../../../../src/core/domains/language/typescript/index.js";

/**
 * The factory is REAL (consolidation, bd tea-rags-mcp-cat4): `create(lang)`
 * ENCAPSULATES construction — it builds the native `domains/language/<lang>`
 * provider itself (`new RubyLanguage(mode)` / `new TypeScriptLanguage(mode)` /
 * …), regardless of any caller-supplied registry. EVERY language is now native
 * (`ruby` / `typescript` / `javascript` / `python` / `go` / `java` / `rust` /
 * `bash` / `markdown`); the legacy per-language adapter + thunk plumbing was
 * removed by tea-rags-mcp-jh40. Unknown languages throw a typed
 * `UnsupportedLanguageError`.
 */
describe("LanguageFactoryImpl", () => {
  it("supported() reflects the native languages (ruby, typescript, javascript, python, go, java, rust, bash, markdown)", () => {
    expect(new Set(new LanguageFactoryImpl().supported())).toEqual(
      new Set(["ruby", "typescript", "javascript", "python", "go", "java", "rust", "bash", "markdown"]),
    );
  });

  it("create() builds the native ruby provider itself", () => {
    expect(new LanguageFactoryImpl().create("ruby")).toBeInstanceOf(RubyLanguage);
  });

  it("create() builds the native typescript provider itself", () => {
    expect(new LanguageFactoryImpl().create("typescript")).toBeInstanceOf(TypeScriptLanguage);
  });

  it("create() builds the native javascript provider itself", () => {
    expect(new LanguageFactoryImpl().create("javascript")).toBeInstanceOf(JavaScriptLanguage);
  });

  it("create() builds the native python provider itself", () => {
    expect(new LanguageFactoryImpl().create("python")).toBeInstanceOf(PythonLanguage);
  });

  it("create() builds the native go provider itself", () => {
    expect(new LanguageFactoryImpl().create("go")).toBeInstanceOf(GoLanguage);
  });

  it("create() builds the native java provider itself", () => {
    expect(new LanguageFactoryImpl().create("java")).toBeInstanceOf(JavaLanguage);
  });

  it("create() builds the native rust provider itself", () => {
    expect(new LanguageFactoryImpl().create("rust")).toBeInstanceOf(RustLanguage);
  });

  it("create() builds the native bash provider itself", () => {
    expect(new LanguageFactoryImpl().create("bash")).toBeInstanceOf(BashLanguage);
  });

  it("create() builds the native markdown provider itself", () => {
    expect(new LanguageFactoryImpl().create("markdown")).toBeInstanceOf(MarkdownLanguage);
  });

  it("the native markdown provider is doc-only — chunkerHooks but no walker/resolver", () => {
    const md = new LanguageFactoryImpl().create("markdown");
    expect(md.chunkerHooks).toBeDefined();
    expect(md.chunkerHooks?.isDocumentation).toBe(true);
    expect(md.walker).toBeUndefined();
    expect(md.resolver).toBeUndefined();
  });

  it("caches the native ruby provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("ruby")).toBe(factory.create("ruby"));
  });

  it("caches the native typescript provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("typescript")).toBe(factory.create("typescript"));
  });

  it("caches the native javascript provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("javascript")).toBe(factory.create("javascript"));
  });

  it("caches the native go provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("go")).toBe(factory.create("go"));
  });

  it("caches the native java provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("java")).toBe(factory.create("java"));
  });

  it("caches the native rust provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("rust")).toBe(factory.create("rust"));
  });

  it("caches the native bash provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("bash")).toBe(factory.create("bash"));
  });

  it("caches the native markdown provider across calls", () => {
    const factory = new LanguageFactoryImpl();
    expect(factory.create("markdown")).toBe(factory.create("markdown"));
  });

  it("create() throws a typed UnsupportedLanguageError for an unregistered language", () => {
    expect(() => new LanguageFactoryImpl().create("cobol")).toThrow(UnsupportedLanguageError);
  });

  it("the thrown error names the requested language", () => {
    expect(() => new LanguageFactoryImpl().create("cobol")).toThrow(/cobol/);
  });
});
