import { describe, expect, it } from "vitest";

import type { LanguageProvider } from "../../../../src/core/contracts/types/language.js";
import { LanguageFactoryImpl } from "../../../../src/core/domains/language/factory.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";
import { GoLanguage } from "../../../../src/core/domains/language/go/index.js";
import { JavaLanguage } from "../../../../src/core/domains/language/java/index.js";
import { JavaScriptLanguage } from "../../../../src/core/domains/language/javascript/index.js";
import { PythonLanguage } from "../../../../src/core/domains/language/python/index.js";
import { RubyLanguage } from "../../../../src/core/domains/language/ruby/index.js";
import { RustLanguage } from "../../../../src/core/domains/language/rust/index.js";
import { BashLanguage } from "../../../../src/core/domains/language/bash/index.js";
import { TypeScriptLanguage } from "../../../../src/core/domains/language/typescript/index.js";

/**
 * The factory is REAL (consolidation, bd tea-rags-mcp-cat4): `create(lang)`
 * ENCAPSULATES construction rather than reading from a consumer-assembled
 * registry of pre-built providers.
 *
 *   - NATIVE languages (`ruby`, `typescript`, `javascript`, `python`, `go`,
 *     `java`, `rust`, `bash`) → the factory constructs the native provider
 *     itself (`new RubyLanguage(mode)` / `new TypeScriptLanguage(mode)` / `new
 *     JavaScriptLanguage(mode)` / `new PythonLanguage(mode)` / `new
 *     GoLanguage(mode)` / `new JavaLanguage(mode)` / `new RustLanguage(mode)` /
 *     `new BashLanguage(mode)`), regardless of any injected thunk.
 *   - LEGACY languages → the factory invokes the deferred builder thunk the
 *     composition layer injected, lazily, on first `create` and caches it.
 *
 * The composition layer supplies the legacy thunks via the legacy adapter (see
 * `legacy-language-adapter.test.ts` for adapter fidelity); these tests cover the
 * factory's own contract with minimal stub thunks, independent of the adapter.
 * Legacy-thunk probes use `markdown` (the ONLY still adapter-served language)
 * since `typescript` / `javascript` / `python` / `go` / `java` / `rust` / `bash`
 * are now native — a thunk for them would be ignored in favour of the native
 * build.
 */
describe("LanguageFactoryImpl", () => {
  const stubProvider: LanguageProvider = {
    kernel: { loadModule: async () => null, isInstanceMethod: () => false },
  };

  it("supported() reflects legacy builder keys plus the native languages (ruby, typescript, javascript, python, go, java, rust, bash)", () => {
    // Empty legacy map still supports the native languages.
    expect(new Set(new LanguageFactoryImpl(new Map()).supported())).toEqual(
      new Set(["ruby", "typescript", "javascript", "python", "go", "java", "rust", "bash"]),
    );
    const factory = new LanguageFactoryImpl(new Map([["markdown", () => stubProvider]]));
    expect(new Set(factory.supported())).toEqual(
      new Set(["markdown", "ruby", "typescript", "javascript", "python", "go", "java", "rust", "bash"]),
    );
  });

  it("create() invokes the legacy thunk and returns its provider", () => {
    const factory = new LanguageFactoryImpl({ markdown: () => stubProvider });
    expect(factory.create("markdown")).toBe(stubProvider);
  });

  it("create() builds the native ruby provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("ruby")).toBeInstanceOf(RubyLanguage);
  });

  it("create() builds the native typescript provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("typescript")).toBeInstanceOf(TypeScriptLanguage);
  });

  it("create() builds the native javascript provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("javascript")).toBeInstanceOf(JavaScriptLanguage);
  });

  it("create() builds the native python provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("python")).toBeInstanceOf(PythonLanguage);
  });

  it("create() builds the native go provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("go")).toBeInstanceOf(GoLanguage);
  });

  it("create() builds the native java provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("java")).toBeInstanceOf(JavaLanguage);
  });

  it("create() builds the native rust provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("rust")).toBeInstanceOf(RustLanguage);
  });

  it("create() builds the native bash provider itself (no thunk needed)", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("bash")).toBeInstanceOf(BashLanguage);
  });

  it("the native switch wins over any legacy thunk registered for ruby", () => {
    // A stray legacy thunk for a native language must NOT shadow the native build.
    const factory = new LanguageFactoryImpl(new Map([["ruby", () => stubProvider]]));
    expect(factory.create("ruby")).toBeInstanceOf(RubyLanguage);
  });

  it("the native switch wins over any legacy thunk registered for typescript", () => {
    const factory = new LanguageFactoryImpl(new Map([["typescript", () => stubProvider]]));
    expect(factory.create("typescript")).toBeInstanceOf(TypeScriptLanguage);
  });

  it("the native switch wins over any legacy thunk registered for javascript", () => {
    const factory = new LanguageFactoryImpl(new Map([["javascript", () => stubProvider]]));
    expect(factory.create("javascript")).toBeInstanceOf(JavaScriptLanguage);
  });

  it("the native switch wins over any legacy thunk registered for python", () => {
    const factory = new LanguageFactoryImpl(new Map([["python", () => stubProvider]]));
    expect(factory.create("python")).toBeInstanceOf(PythonLanguage);
  });

  it("the native switch wins over any legacy thunk registered for go", () => {
    const factory = new LanguageFactoryImpl(new Map([["go", () => stubProvider]]));
    expect(factory.create("go")).toBeInstanceOf(GoLanguage);
  });

  it("the native switch wins over any legacy thunk registered for java", () => {
    const factory = new LanguageFactoryImpl(new Map([["java", () => stubProvider]]));
    expect(factory.create("java")).toBeInstanceOf(JavaLanguage);
  });

  it("the native switch wins over any legacy thunk registered for rust", () => {
    const factory = new LanguageFactoryImpl(new Map([["rust", () => stubProvider]]));
    expect(factory.create("rust")).toBeInstanceOf(RustLanguage);
  });

  it("the native switch wins over any legacy thunk registered for bash", () => {
    const factory = new LanguageFactoryImpl(new Map([["bash", () => stubProvider]]));
    expect(factory.create("bash")).toBeInstanceOf(BashLanguage);
  });

  it("caches per language — the legacy thunk runs at most once", () => {
    let calls = 0;
    const factory = new LanguageFactoryImpl(
      new Map([
        [
          "markdown",
          () => {
            calls += 1;
            return stubProvider;
          },
        ],
      ]),
    );
    const a = factory.create("markdown");
    const b = factory.create("markdown");
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("caches the native ruby provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("ruby")).toBe(factory.create("ruby"));
  });

  it("caches the native typescript provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("typescript")).toBe(factory.create("typescript"));
  });

  it("caches the native javascript provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("javascript")).toBe(factory.create("javascript"));
  });

  it("caches the native go provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("go")).toBe(factory.create("go"));
  });

  it("caches the native java provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("java")).toBe(factory.create("java"));
  });

  it("caches the native rust provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("rust")).toBe(factory.create("rust"));
  });

  it("caches the native bash provider across calls", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(factory.create("bash")).toBe(factory.create("bash"));
  });

  it("accepts both a ReadonlyMap and a Record of legacy builders", () => {
    expect(new LanguageFactoryImpl(new Map([["ts", () => stubProvider]])).create("ts")).toBe(stubProvider);
    expect(new LanguageFactoryImpl({ ts: () => stubProvider }).create("ts")).toBe(stubProvider);
  });

  it("create() throws a typed UnsupportedLanguageError for an unregistered language", () => {
    const factory = new LanguageFactoryImpl(new Map([["typescript", () => stubProvider]]));
    expect(() => factory.create("cobol")).toThrow(UnsupportedLanguageError);
  });

  it("the thrown error names the requested language", () => {
    const factory = new LanguageFactoryImpl(new Map());
    expect(() => factory.create("cobol")).toThrow(/cobol/);
  });
});
