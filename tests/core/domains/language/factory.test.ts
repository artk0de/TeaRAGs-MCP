import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../src/core/contracts/types/codegraph.js";
import { BashLanguage } from "../../../../src/core/domains/language/bash/index.js";
import { UnsupportedLanguageError } from "../../../../src/core/domains/language/errors.js";
import { LanguageFactory } from "../../../../src/core/domains/language/factory.js";
import { GoLanguage } from "../../../../src/core/domains/language/go/index.js";
import { JavaLanguage } from "../../../../src/core/domains/language/java/index.js";
import { JavaScriptLanguage } from "../../../../src/core/domains/language/javascript/index.js";
import { MarkdownLanguage } from "../../../../src/core/domains/language/markdown/index.js";
import { PythonLanguage } from "../../../../src/core/domains/language/python/index.js";
import { RubyLanguage } from "../../../../src/core/domains/language/ruby/index.js";
import { RustLanguage } from "../../../../src/core/domains/language/rust/index.js";
import { TypeScriptLanguage } from "../../../../src/core/domains/language/typescript/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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
describe("LanguageFactory", () => {
  it("supported() reflects the native languages (ruby, typescript, javascript, python, go, java, rust, bash, markdown)", () => {
    expect(new Set(new LanguageFactory().supported())).toEqual(
      new Set(["ruby", "typescript", "javascript", "python", "go", "java", "rust", "bash", "markdown"]),
    );
  });

  it("create() builds the native ruby provider itself", () => {
    expect(new LanguageFactory().create("ruby")).toBeInstanceOf(RubyLanguage);
  });

  it("create() builds the native typescript provider itself", () => {
    expect(new LanguageFactory().create("typescript")).toBeInstanceOf(TypeScriptLanguage);
  });

  it("create() builds the native javascript provider itself", () => {
    expect(new LanguageFactory().create("javascript")).toBeInstanceOf(JavaScriptLanguage);
  });

  it("create() builds the native python provider itself", () => {
    expect(new LanguageFactory().create("python")).toBeInstanceOf(PythonLanguage);
  });

  it("create() builds the native go provider itself", () => {
    expect(new LanguageFactory().create("go")).toBeInstanceOf(GoLanguage);
  });

  it("create() builds the native java provider itself", () => {
    expect(new LanguageFactory().create("java")).toBeInstanceOf(JavaLanguage);
  });

  it("create() builds the native rust provider itself", () => {
    expect(new LanguageFactory().create("rust")).toBeInstanceOf(RustLanguage);
  });

  it("create() builds the native bash provider itself", () => {
    expect(new LanguageFactory().create("bash")).toBeInstanceOf(BashLanguage);
  });

  it("create() builds the native markdown provider itself", () => {
    expect(new LanguageFactory().create("markdown")).toBeInstanceOf(MarkdownLanguage);
  });

  it("the native markdown provider is doc-only — chunkerHooks but no walker/resolver", () => {
    const md = new LanguageFactory().create("markdown");
    expect(md.chunkerHooks).toBeDefined();
    expect(md.chunkerHooks?.isDocumentation).toBe(true);
    expect(md.walker).toBeUndefined();
    expect(md.resolver).toBeUndefined();
  });

  it("caches the native ruby provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("ruby")).toBe(factory.create("ruby"));
  });

  it("caches the native typescript provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("typescript")).toBe(factory.create("typescript"));
  });

  it("caches the native javascript provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("javascript")).toBe(factory.create("javascript"));
  });

  it("caches the native go provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("go")).toBe(factory.create("go"));
  });

  it("caches the native java provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("java")).toBe(factory.create("java"));
  });

  it("caches the native rust provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("rust")).toBe(factory.create("rust"));
  });

  it("caches the native bash provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("bash")).toBe(factory.create("bash"));
  });

  it("caches the native markdown provider across calls", () => {
    const factory = new LanguageFactory();
    expect(factory.create("markdown")).toBe(factory.create("markdown"));
  });

  it("create() throws a typed UnsupportedLanguageError for an unregistered language", () => {
    expect(() => new LanguageFactory().create("cobol")).toThrow(UnsupportedLanguageError);
  });

  it("the thrown error names the requested language", () => {
    expect(() => new LanguageFactory().create("cobol")).toThrow(/cobol/);
  });
});

/**
 * The root the TypeScript resolver reads its tsconfig from (bd tea-rags-mcp-f4wcm).
 *
 * `TypeScriptLanguage` used to compute `process.cwd()` itself, and `create(lang)`
 * offered no way to say otherwise — so an index run launched from anywhere but
 * the target project's root read the WRONG `tsconfig.json`. That is the normal
 * case, not an edge one: the CLI is routinely run from tea-rags-mcp's own
 * checkout with `--project <other>`. It defeated the path-alias work in
 * bd tea-rags-mcp-9owaa entirely — a live `--force-enrichments codegraph` run on
 * taxdome moved bareCall 7784 -> 7798 of ~131 460, while the same fix measured
 * 703 -> 6820 resolved edges when exercised against taxdome's real tsconfig
 * directly.
 *
 * The assertion is behavioural rather than a getter check: with the right root
 * the alias resolves and the call is INTERNAL; with `process.cwd()` (this repo,
 * whose own tsconfig declares no `paths`) the specifier maps to nothing and
 * `targetsExternalImport` calls it external. Nothing else distinguishes the two.
 */
describe("LanguageFactory repoRoot threading (bd tea-rags-mcp-f4wcm)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "language-factory-root-"));
    mkdirSync(join(repoRoot, "app"), { recursive: true });
    writeFileSync(join(repoRoot, "app", "client.ts"), "export const client = { get: (u: string) => u };\n");
    writeFileSync(
      join(repoRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "*": ["./app/*"] } } }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function callAndContext(importText: string, bound: string): { call: CallRef; ctx: CallContext } {
    return {
      call: { callText: `${bound}.get(u)`, receiver: bound, member: "get", startLine: 5 },
      ctx: {
        callerFile: "app/page.tsx",
        callerScope: [],
        imports: [{ importText, startLine: 1, importedNames: [bound] }],
        symbolTable: new InMemoryGlobalSymbolTable(),
      },
    };
  }

  it("reads the tsconfig of the root it was given, not of process.cwd()", () => {
    const provider = new LanguageFactory({ repoRoot }).create("typescript");
    const { call, ctx } = callAndContext("client", "client");
    expect(provider.resolver?.targetsExternalImport?.(call, ctx)).toBe(false);
  });

  it("still calls a genuine npm import external under that same root", () => {
    // Guards the other direction: threading a root must not turn the classifier
    // into a rubber stamp that maps everything into the project.
    const provider = new LanguageFactory({ repoRoot }).create("typescript");
    const { call, ctx } = callAndContext("axios", "axios");
    expect(provider.resolver?.targetsExternalImport?.(call, ctx)).toBe(true);
  });

  it("defaults to process.cwd() when no root is supplied, so existing callers are unaffected", () => {
    const provider = new LanguageFactory().create("typescript");
    const { call, ctx } = callAndContext("node:fs", "fs");
    expect(provider.resolver?.targetsExternalImport?.(call, ctx)).toBe(true);
  });

  it("keeps its own default root when TypeScriptLanguage is constructed directly", () => {
    // Anything building the provider outside the factory (tests, scripts run
    // from the target repo) must not have to learn a new parameter.
    const provider = new TypeScriptLanguage();
    const { call, ctx } = callAndContext("node:fs", "fs");
    expect(provider.resolver.targetsExternalImport?.(call, ctx)).toBe(true);
  });
});
