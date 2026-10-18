import { createRequire } from "node:module";

import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import type { LanguageCapability } from "../../../../../src/core/contracts/types/language.js";
import { renderReadme } from "../../../../../src/core/domains/language/capability/readme.js";
import { renderRule } from "../../../../../src/core/domains/language/capability/rule.js";
import { resolveLanguageCodeVersions } from "../../../../../src/core/domains/language/capability/versions.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

const nodeRequire = createRequire(import.meta.url);
const capabilities = new LanguageFactory().capabilities();
const evidence = "tests/core/domains/language/capability/version-policy.test.ts";

function withPolicy(languageVersion: unknown): Map<string, LanguageCapability> {
  const caps = new Map(capabilities);
  caps.set("rust", { ...caps.get("rust")!, languageVersion } as LanguageCapability);
  return caps;
}

describe("language version policy", () => {
  it.each([...capabilities.keys()])("declares an explicit, evidenced policy for %s", (language) => {
    const cap = capabilities.get(language)!;
    expect(cap).toHaveProperty("languageVersion");
    expect(cap.languageVersion).toMatchObject({ evidence, limitations: expect.any(String) });
    expect(cap.languageVersion.limitations.length).toBeGreaterThan(0);
  });

  it("records Rust's highest fixture-validated release without claiming compiler conformance", () => {
    expect(capabilities.get("rust")!.languageVersion).toMatchObject({
      policy: "fixture-validated",
      target: "Rust 1.88.0 / edition 2024",
    });
    expect(renderReadme(capabilities)).toContain("not compiler conformance");
    expect(renderRule(capabilities)).toContain("latest upstream release unverified");
  });

  it.each([renderReadme, renderRule])("rejects absent or inconsistent metadata before rendering (%#)", (render) => {
    for (const invalid of [
      undefined,
      {},
      { policy: "grammar-bounded", evidence, limitations: "" },
      { policy: "fixture-validated", evidence, limitations: "syntax only" },
      { policy: "grammar-bounded", target: "latest", evidence, limitations: "syntax only" },
      { policy: "unversioned", evidence: "", limitations: "syntax only" },
    ]) {
      expect(() => render(withPolicy(invalid))).toThrow();
    }
  });

  it.each([renderReadme, renderRule])("renders policy and installed grammar version separately (%#)", (render) => {
    const output = render(capabilities);
    const grammarVersion = (nodeRequire("tree-sitter-rust/package.json") as { version: string }).version;
    expect(output).toContain("Language / toolchain policy");
    expect(output).toContain("Grammar package version");
    expect(output).toContain(`tree-sitter-rust@${grammarVersion}`);
    expect(output).toContain("Rust 1.88.0 / edition 2024");
    for (const cap of capabilities.values()) {
      expect(output).toContain(cap.languageVersion.limitations);
    }
  });

  it("keeps language policy out of the index-format revision stamp", () => {
    const before = resolveLanguageCodeVersions(capabilities);
    const after = resolveLanguageCodeVersions(
      withPolicy({
        policy: "grammar-bounded",
        evidence,
        limitations: "Changed documentation, not indexed output",
      }),
    );
    expect(after).toEqual(before);
  });

  it.each([
    ["ruby", "class Service; def run(value); value; end; end"],
    ["typescript", "interface Value { name: string }; const run = (value: Value): string => value.name;"],
    ["javascript", "export const run = (value) => value?.name ?? 'unknown';"],
    ["python", "class Service:\n    def run(self, value: str) -> str:\n        return value\n"],
    ["go", "package service\nfunc Run(value string) string { return value }\n"],
    ["java", "class Service { String run(String value) { return value; } }"],
    ["bash", "run() { printf '%s' \"$1\"; }"],
    ["swift", "struct Service { func run(value: String) -> String { return value } }"],
  ])("bounds %s syntax fixtures to the descriptor's installed grammar", (language, source) => {
    const cap = capabilities.get(language)!;
    expect(cap.languageVersion.policy).toBe("grammar-bounded");
    const parser = new Parser();
    const grammar = nodeRequire(cap.ast.grammarPackage!);
    parser.setLanguage(language === "typescript" ? grammar.typescript : grammar);
    expect(parser.parse(source).rootNode.hasError).toBe(false);
  });

  it("uses an unversioned dialect policy only for native languages without a grammar", () => {
    for (const cap of capabilities.values()) {
      expect(cap.languageVersion.policy === "unversioned").toBe(cap.ast.grammarPackage === undefined);
    }
  });

  it("validates Rust 1.88 let-chains and edition-2024 async closure syntax with the installed grammar", () => {
    const parser = new Parser();
    parser.setLanguage(nodeRequire("tree-sitter-rust"));
    const source = `
      async fn run(input: Option<i32>) {
        let callback = async || 42;
        if let Some(value) = input && value > 0 { callback().await; }
      }
    `;
    const tree = parser.parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType("let_chain")).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType("closure_expression")).toHaveLength(1);
  });
});
