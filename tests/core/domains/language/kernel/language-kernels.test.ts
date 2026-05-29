/**
 * Behavioral tests for the per-language `LanguageKernel` slices
 * (`domains/language/<lang>/kernel.ts`). The factory test
 * (`tests/core/domains/language/factory.test.ts`) only constructs the providers
 * — it never invokes a kernel's `isInstanceMethod`, `loadModule`, or
 * `extractLanguage`. These tests exercise those capabilities directly so the
 * detection + parser-load contract each kernel inherits from its
 * `LANGUAGE_DEFINITIONS` ancestor stays pinned.
 *
 * `isInstanceMethod` is derived from `classifyMethod` (infra/symbolid): for the
 * source languages a parsed instance method node returns `true`; a non-method
 * node returns `false`. Markdown never sees code nodes, so every node is
 * `false`.
 *
 * Parser construction mirrors the sibling walker tests (real tree-sitter +
 * real grammar, no mocks).
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { bashKernel } from "../../../../../src/core/domains/language/bash/index.js";
import { goKernel } from "../../../../../src/core/domains/language/go/index.js";
import { javaKernel } from "../../../../../src/core/domains/language/java/index.js";
import { javascriptKernel } from "../../../../../src/core/domains/language/javascript/index.js";
import { markdownKernel } from "../../../../../src/core/domains/language/markdown/index.js";
import { pythonKernel } from "../../../../../src/core/domains/language/python/index.js";
import { rubyKernel } from "../../../../../src/core/domains/language/ruby/index.js";
import { rustKernel } from "../../../../../src/core/domains/language/rust/index.js";
import { typescriptKernel } from "../../../../../src/core/domains/language/typescript/index.js";

function findFirst(tree: Parser.Tree, type: string): Parser.SyntaxNode {
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    for (const child of node.namedChildren) stack.push(child);
  }
  throw new Error(`No ${type} node found`);
}

const sourceKernels = {
  ruby: rubyKernel,
  typescript: typescriptKernel,
  javascript: javascriptKernel,
  python: pythonKernel,
  go: goKernel,
  java: javaKernel,
  rust: rustKernel,
  bash: bashKernel,
} as const;

describe("LanguageKernel.isInstanceMethod", () => {
  it("ruby kernel classifies a plain `def` node as an instance method", () => {
    const parser = new Parser();
    parser.setLanguage(RbLang as unknown as Parser.Language);
    const tree = parser.parse("class C\n  def greet\n  end\nend\n");
    const methodNode = findFirst(tree, "method");
    expect(rubyKernel.isInstanceMethod(methodNode)).toBe(true);
  });

  it("ruby kernel classifies a `def self.foo` singleton_method as NOT an instance method", () => {
    const parser = new Parser();
    parser.setLanguage(RbLang as unknown as Parser.Language);
    const tree = parser.parse("class C\n  def self.build\n  end\nend\n");
    const methodNode = findFirst(tree, "singleton_method");
    expect(rubyKernel.isInstanceMethod(methodNode)).toBe(false);
  });

  it("ruby kernel classifies a non-method node (class) as NOT an instance method", () => {
    const parser = new Parser();
    parser.setLanguage(RbLang as unknown as Parser.Language);
    const tree = parser.parse("class C\nend\n");
    const classNode = findFirst(tree, "class");
    expect(rubyKernel.isInstanceMethod(classNode)).toBe(false);
  });

  it.each(Object.entries(sourceKernels))(
    "%s kernel's isInstanceMethod returns false for a non-method ruby node (cross-language detection is conservative)",
    (_lang, kernel) => {
      const parser = new Parser();
      parser.setLanguage(RbLang as unknown as Parser.Language);
      const tree = parser.parse("1 + 1\n");
      const node = tree.rootNode;
      expect(kernel.isInstanceMethod(node)).toBe(false);
    },
  );

  it("markdown kernel's isInstanceMethod returns false for a non-method node (moot — markdown has no walker)", () => {
    const parser = new Parser();
    parser.setLanguage(RbLang as unknown as Parser.Language);
    const tree = parser.parse("1 + 1\n");
    expect(markdownKernel.isInstanceMethod(tree.rootNode)).toBe(false);
  });
});

describe("LanguageKernel.loadModule + extractLanguage", () => {
  it.each(Object.entries(sourceKernels))(
    "%s kernel.loadModule resolves a real grammar module",
    async (_lang, kernel) => {
      const mod = await kernel.loadModule();
      expect(mod).toBeTruthy();
      if (kernel.extractLanguage) {
        const lang = kernel.extractLanguage(mod!);
        expect(lang).toBeTruthy();
        // The extracted language must be usable by a real Parser.
        const parser = new Parser();
        expect(() => {
          parser.setLanguage(lang as Parser.Language);
        }).not.toThrow();
      }
    },
  );

  it("markdown kernel.loadModule resolves to null (no tree-sitter grammar)", async () => {
    await expect(markdownKernel.loadModule()).resolves.toBeNull();
  });

  it("markdown kernel declares no extractLanguage (doc-only, no scope composition)", () => {
    expect(markdownKernel.extractLanguage).toBeUndefined();
  });
});
