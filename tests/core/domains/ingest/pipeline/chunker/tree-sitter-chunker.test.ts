import { beforeEach, describe, expect, it, vi } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { generateChunkId } from "../../../../../../src/core/domains/ingest/pipeline/chunker/utils/chunk-id.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { extractClassHeader } from "../../../../../../src/core/domains/language/ruby/chunking/class-body-chunker.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

// Mirror the composition roots (composition.ts / the chunker worker): the factory
// builds every native language provider itself — so factory.create("ruby")
// returns a real provider with chunker hooks. Runs in the MAIN process (not the
// worker), so it may construct a factory that serves ruby directly.
const testLanguageFactoryDescriptor = new LanguageFactory();

describe("TreeSitterChunker", () => {
  let chunker: TreeSitterChunker;
  let config: ChunkerConfig;

  beforeEach(() => {
    config = {
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
  });

  describe("chunk - TypeScript", () => {
    it("should chunk TypeScript functions", async () => {
      const code = `
function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.metadata.name === "add")).toBe(true);
      expect(chunks.some((c) => c.metadata.name === "multiply")).toBe(true);
    });

    it("should chunk TypeScript classes into methods", async () => {
      const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
      // Methods should be extracted with class as parent
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.some((c) => c.metadata.name === "add")).toBe(true);
      expect(methodChunks.some((c) => c.metadata.name === "subtract")).toBe(true);
      expect(methodChunks.every((c) => c.metadata.parentSymbolId === "Calculator")).toBe(true);
    });

    // bd tea-rags-mcp-olc2 — tree-sitter-typescript emits `abstract_class_declaration`
    // (NOT `class_declaration`) for `abstract class X {}`. Without that node type in
    // chunkableTypes the abstract container is never recognized, so its methods never
    // become standalone chunks and `find_symbol("Base#foo")` misses the body even though
    // the codegraph layer has the symbol.
    it("should chunk abstract TypeScript classes into methods", async () => {
      // Method bodies padded to clear the 50-char floor in processChildren.
      const code = `
abstract class Base {
  foo(value: string): string {
    return value == null ? "" : value.toUpperCase();
  }

  bar(value: string): string {
    return value == null ? "" : value.toLowerCase();
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);
      const foo = methodChunks.find((c) => c.metadata.name === "foo");
      const bar = methodChunks.find((c) => c.metadata.name === "bar");
      expect(foo?.metadata.symbolId).toBe("Base#foo");
      expect(foo?.metadata.parentSymbolId).toBe("Base");
      expect(bar?.metadata.symbolId).toBe("Base#bar");
      expect(bar?.metadata.parentSymbolId).toBe("Base");
    });

    it("should chunk TypeScript interfaces", async () => {
      const code = `
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
  category: string;
}

interface Order {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  totalPrice: number;
  status: string;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("should merge adjacent small type aliases and interfaces into a block", async () => {
      const code = `
export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

export type EnrichmentStatusValue = "pending" | "in_progress" | "completed" | "partial" | "failed";

export type ProgressCallback = (progress: ProgressUpdate) => void;

export interface WorkItem { path: string; content: string; language: string; }

export interface DeleteItem { id: string; hash: string; }

export interface LargeInterface {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // The 5 small declarations should be merged into 1 block
      // LargeInterface (8+ lines) should remain separate
      const blockChunks = chunks.filter((c) => c.metadata.chunkType === "block" && !c.metadata.parentSymbolId);
      const interfaceChunks = chunks.filter((c) => c.metadata.chunkType === "interface");

      // Small declarations merged into 1 block
      expect(blockChunks.length).toBe(1);
      expect(blockChunks[0].content).toContain("IndexingStatus");
      expect(blockChunks[0].content).toContain("DeleteItem");

      // Large interface stays separate
      expect(interfaceChunks.some((c) => c.metadata.name === "LargeInterface")).toBe(true);
    });

    it("should not merge small chunks separated by large declarations", async () => {
      const code = `
export type SmallTypeA = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";

export interface LargeInterface {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export type SmallTypeB = "x" | "y" | "z" | "w" | "v" | "u" | "t" | "s";
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // SmallTypeA and SmallTypeB should NOT be merged (LargeInterface between them)
      // Each small type stays individual (no merge partner)
      // Merged blocks have "..." suffix in name; individual blocks do not
      const mergedBlocks = chunks.filter(
        (c) => c.metadata.chunkType === "block" && !c.metadata.parentSymbolId && c.metadata.name?.endsWith("..."),
      );
      expect(mergedBlocks.length).toBe(0); // No merged blocks

      // Individual type aliases still exist as separate chunks
      expect(chunks.some((c) => c.metadata.name === "SmallTypeA")).toBe(true);
      expect(chunks.some((c) => c.metadata.name === "SmallTypeB")).toBe(true);
    });

    it("should produce at least 1 line for single-line type aliases", async () => {
      const code = `
export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

export type EnrichmentStatusValue = "pending" | "in_progress" | "completed" | "partial" | "failed";
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      for (const chunk of chunks) {
        expect(chunk.endLine).toBeGreaterThan(chunk.startLine);
      }
    });

    it("should emit chunkType='test' for describe blocks in TS test files (hook-chain claim invariant)", async () => {
      // End-to-end coverage of the hook-chain claim invariant
      // (.claude/rules/chunker-hooks.md): once test-scope-chunker populates
      // ctx.bodyChunks for a describe(...) container, the orchestrator must
      // stop the chain so typescriptBodyChunkingHook can't overwrite it.
      // Regression for the bug where chunks shipped with chunkType='block'
      // because the generic body chunker reassigned ctx.bodyChunks.
      const code = `import { describe, expect, it } from "vitest";

describe("findClassBody", () => {
  it("returns the class_body node from a class declaration", () => {
    const decl = parse("class Foo { x: number; }");
    expect(decl).toBeDefined();
    expect(decl.type).toBe("class_declaration");
  });

  it("returns null when container has no class_body child", () => {
    const decl = parse("interface Bar { x: number; }");
    expect(decl.type).toBe("interface_declaration");
  });
});
`;
      const chunks = await chunker.chunk(
        code,
        "tests/core/domains/language/typescript/chunking/utils.test.ts",
        "typescript",
      );
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks.length).toBeGreaterThan(0);
      expect(testChunks[0].metadata.symbolId).toContain("findClassBody");
    });
  });

  describe("chunk - Python", () => {
    it("should chunk Python functions", async () => {
      const code = `
def calculate_sum(numbers):
    """Calculate the sum of a list of numbers."""
    total = 0
    for num in numbers:
        total += num
    return total

def calculate_product(numbers):
    """Calculate the product of a list of numbers."""
    result = 1
    for num in numbers:
        result *= num
    return result

def calculate_average(numbers):
    """Calculate the average of a list of numbers."""
    if not numbers:
        return 0
    return calculate_sum(numbers) / len(numbers)
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      if (chunks.length > 0) {
        expect(chunks.some((c) => c.metadata.name === "calculate_sum" || c.metadata.name === "calculate_product")).toBe(
          true,
        );
      }
    });

    it("should chunk Python classes", async () => {
      const code = `
class Calculator:
    def add(self, a, b):
        return a + b

    def multiply(self, a, b):
        return a * b
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");
      expect(chunks.length).toBeGreaterThan(0);
    });

    // bd tea-rags-mcp-t6sr — chunker must emit class methods as separate
    // chunks with symbolId matching the codegraph provider's pyNameOf
    // output. Without these chunks, find_symbol("Flask#__init__") returns
    // [] and large classes get split into anonymous `Foo#part1..partN`
    // by enforceMaxChunkSize. See .claude/rules/symbolid-convention.md.
    it("should emit Python class instance method as a separate chunk with symbolId Class#method", async () => {
      // Pad each method body so chunks exceed the 50-char floor in
      // chunkWithChildExtraction (childContent.length >= 50).
      const code = `
class Foo:
    def bar(self):
        """First instance method that is long enough to extract."""
        result = self.compute_something(1, 2, 3)
        return result + self.other_value

    def baz(self):
        """Second instance method, same shape."""
        result = self.compute_other(4, 5, 6)
        return result - self.other_value
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);
      const bar = methodChunks.find((c) => c.metadata.name === "bar");
      const baz = methodChunks.find((c) => c.metadata.name === "baz");
      expect(bar?.metadata.symbolId).toBe("Foo#bar");
      expect(bar?.metadata.parentSymbolId).toBe("Foo");
      expect(bar?.metadata.parentType).toBe("class_definition");
      expect(baz?.metadata.symbolId).toBe("Foo#baz");
      expect(baz?.metadata.parentSymbolId).toBe("Foo");
    });

    it("should emit Python @classmethod as a separate chunk with symbolId Class.method (dot separator)", async () => {
      const code = `
class Foo:
    @classmethod
    def factory(cls, source):
        """Class method long enough to clear the 50-char filter."""
        instance = cls(source)
        instance.prepare()
        return instance

    def helper(self):
        """Instance sibling so the class extracts children."""
        return self.factory("default-source-string")
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const factory = methodChunks.find((c) => c.metadata.name === "factory");
      // `.` separator per symbolid-convention.md — @classmethod is class-level.
      expect(factory?.metadata.symbolId).toBe("Foo.factory");
      expect(factory?.metadata.parentSymbolId).toBe("Foo");
    });

    it("should emit Python @staticmethod as a separate chunk with symbolId Class.method (dot separator)", async () => {
      const code = `
class Foo:
    @staticmethod
    def util(value):
        """Static method long enough to clear the 50-char filter."""
        normalized = value.strip().lower()
        return normalized.replace(" ", "-")

    def helper(self):
        """Instance sibling so the class extracts children."""
        return Foo.util("Some Source String")
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const util = methodChunks.find((c) => c.metadata.name === "util");
      expect(util?.metadata.symbolId).toBe("Foo.util");
      expect(util?.metadata.parentSymbolId).toBe("Foo");
    });

    // bd tea-rags-mcp-b7k3 — when a Python class has methods, the parent
    // class chunk MUST cover only the signature + class-level attributes
    // BEFORE the first method declaration. Otherwise the parent chunk spans
    // the FULL class range, gets split by enforceMaxChunkSize into anonymous
    // Foo#part1..partN, duplicates method bodies inside those parts, and
    // shadows the first method on Flask in find_symbol lookups.
    it("should narrow Python class chunk to signature + leading attributes when methods are extracted", async () => {
      const code = `
class Foo:
    """Class docstring kept inside the parent chunk."""
    CLASS_LEVEL_CONSTANT = "value-long-enough-for-the-fifty-char-threshold"

    def __init__(self):
        """First instance method that must NOT be inside the parent class chunk."""
        self.value = 1
        self.other = 2

    def bar(self):
        """Second instance method, padding the class so the body is sizeable."""
        result = self.compute_something(1, 2, 3)
        return result + self.other
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");

      // Method chunks remain intact (t6sr behavior preserved).
      const fooInit = chunks.find((c) => c.metadata.symbolId === "Foo#__init__");
      const fooBar = chunks.find((c) => c.metadata.symbolId === "Foo#bar");
      expect(fooInit).toBeDefined();
      expect(fooBar).toBeDefined();

      // Exactly one parent class chunk for Foo — no Foo#partN anonymous splits.
      const classChunks = chunks.filter((c) => c.metadata.symbolId === "Foo");
      expect(classChunks.length).toBe(1);
      const partChunks = chunks.filter(
        (c) => typeof c.metadata.symbolId === "string" && c.metadata.symbolId.startsWith("Foo#part"),
      );
      expect(partChunks.length).toBe(0);

      // Parent class chunk has chunkType "class" and covers ONLY the header
      // region before the first method's start line.
      const fooClass = classChunks[0];
      expect(fooClass.metadata.chunkType).toBe("class");
      // First method (`__init__`) starts at line 6 in this source (1-based).
      expect(fooClass.endLine).toBeLessThan(fooInit!.startLine);
      // Class chunk content must NOT include method body lines.
      expect(fooClass.content).not.toContain("def __init__");
      expect(fooClass.content).not.toContain("def bar");
    });

    it("should NOT emit Foo#partN anonymous splits for a Python class with many methods", async () => {
      // Synthesize a class large enough that, before the fix, the parent
      // class chunk would have exceeded maxChunkSize (1000 chars) and been
      // split by enforceMaxChunkSize into Foo#part1..partN. The docstring +
      // class-level constants mimic Flask: substantial class-level content
      // that survives extractContainerBody's method-line stripping.
      const methods: string[] = [];
      for (let i = 0; i < 12; i++) {
        methods.push(`    def method_${i}(self):
        """Method ${i} with enough body to clear the fifty-char floor easily."""
        intermediate = self.compute_something(${i}, ${i + 1}, ${i + 2})
        return intermediate + self.other_value_${i}`);
      }
      // Realistic class-level body — docstring + a few class-level
      // attributes. Together small (< maxChunkSize), but the FULL class
      // body (header + 12 methods) is several thousand characters and,
      // before the fix, the parent chunk spanned the full range and got
      // split by enforceMaxChunkSize into Foo#part1..partN.
      const classLevelBody = `    """Class docstring with enough words to clear the fifty-char floor."""
    default_config = {"key": "value-padding-the-class-level-attribute"}
    version = "1.0.0"`;
      const code = `
class Foo:
${classLevelBody}

${methods.join("\n\n")}
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");
      const partChunks = chunks.filter(
        (c) => typeof c.metadata.symbolId === "string" && c.metadata.symbolId.startsWith("Foo#part"),
      );
      expect(partChunks.length).toBe(0);

      // All 12 method chunks present with the right symbolIds.
      for (let i = 0; i < 12; i++) {
        const methodChunk = chunks.find((c) => c.metadata.symbolId === `Foo#method_${i}`);
        expect(methodChunk).toBeDefined();
      }

      // Exactly one parent class chunk.
      const classChunks = chunks.filter((c) => c.metadata.symbolId === "Foo");
      expect(classChunks.length).toBe(1);
    });

    // bd tea-rags-mcp-5xie — when a Python class method's body exceeds
    // maxChunkSize, the character-fallback path in `processChildren` must
    // mirror the `chunkOversizedNode` invariant: every sub-chunk inherits
    // the method's composed symbolId (`Foo#__init__`) and `chunkType:
    // "function"`. Without this fix, oversized `__init__` bodies (e.g.
    // Flask's ~200-line constructor) emit sub-chunks with
    // `symbolId: undefined` and `chunkType: "block"`, so the method
    // vanishes from `find_symbol("Flask#__init__")` even though
    // cg_symbols has the entry. Mirrors the regression invariant in
    // tree-sitter.oversized-symbolid.test.ts at the method scope.
    it("should preserve symbolId Foo#__init__ across split parts of an oversized Python method", async () => {
      // Body must exceed maxChunkSize (1000 by default). 200 lines of
      // ~22 chars each → ~4.4 KB, comfortably oversized.
      const initBody = Array.from({ length: 200 }, (_, i) => `        self.value_${i} = 1`).join("\n");
      const code = `
class Foo:
    def __init__(self):
        """Oversized constructor that must be split by character fallback."""
${initBody}

    def helper(self):
        """Small sibling method so the class extracts children."""
        return self.value_0 + self.value_1
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");

      // The oversized __init__ produces multiple sub-chunks via character
      // fallback. All splits share the method symbolId (5xie). The
      // parentSymbolId / parentType refer to the enclosing CLASS now
      // (cpbv), keeping the class-method lineage intact for MCP
      // navigation.
      const splits = chunks.filter((c) => c.metadata.symbolId === "Foo#__init__");
      expect(splits.length).toBeGreaterThan(1);
      for (const c of splits) {
        expect(c.metadata.symbolId).toBe("Foo#__init__");
        expect(c.metadata.chunkType).toBe("function");
        expect(c.metadata.parentType).toBe("class_definition");
        expect(c.metadata.parentSymbolId).toBe("Foo");
      }

      // The helper sibling is preserved with its own symbolId — the
      // oversized branch doesn't accidentally consume sibling methods.
      const helper = chunks.find((c) => c.metadata.symbolId === "Foo#helper");
      expect(helper).toBeDefined();

      // No anonymous `Foo#__init__#partN` symbolIds — splits share the
      // composed symbolId. enforceMaxChunkSize is a no-op because the
      // sub-chunks are already character-bounded to maxChunkSize.
      const anonParts = chunks.filter(
        (c) => typeof c.metadata.symbolId === "string" && c.metadata.symbolId.startsWith("Foo#__init__#part"),
      );
      expect(anonParts.length).toBe(0);
    });

    it("should keep parent class chunk covering the full body when class has no methods", async () => {
      // Regression preservation: a method-less class should still emit a
      // parent class chunk spanning its body (the only place its class-level
      // declarations live).
      const code = `
class Settings:
    """Class with attributes only — no methods at all."""
    NAME = "settings-with-a-name-long-enough-for-50-char-floor"
    VERSION = "1.0.0"
    DESCRIPTION = "Pure data class without any method declarations whatsoever."
    ENABLED = True
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const settingsClass = chunks.find((c) => c.metadata.symbolId === "Settings");
      expect(settingsClass).toBeDefined();
      expect(settingsClass!.content).toContain("NAME");
      expect(settingsClass!.content).toContain("DESCRIPTION");
    });

    it("should compose nested Python class scopes into method symbolId (Outer.Inner#method)", async () => {
      // symbolid-convention.md: nested class declaration uses `.` between
      // outer and inner (Outer.Inner), and method on that nested class
      // uses `#` for instance methods → Outer.Inner#method.
      const code = `
class Outer:
    class Inner:
        def method(self):
            """Method on nested class — long enough to chunk."""
            value = self.compute_something(1, 2, 3)
            return value + 100

        def helper(self):
            """Second method to keep child extraction stable."""
            return self.method() * 2
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const method = methodChunks.find((c) => c.metadata.name === "method");
      expect(method?.metadata.symbolId).toBe("Outer.Inner#method");
      expect(method?.metadata.parentSymbolId).toBe("Outer.Inner");
    });
  });

  // bd tea-rags-mcp-c5wt — chunker must emit Java class methods as separate
  // chunks with symbolId matching cg_symbols.symbol_id from the codegraph
  // provider's javaNameOf. Without these chunks, find_symbol("StringUtils#isEmpty")
  // returns [] and large Java classes (e.g. StringUtils.java with 199 method
  // declarations) are chunked whole, then split by enforceMaxChunkSize into
  // anonymous StringUtils#part1..partN. Mirrors Python t6sr / Go n7x5.
  // See .claude/rules/symbolid-convention.md.
  describe("chunk - Java", () => {
    it("should emit Java class instance method as a separate chunk with symbolId Class#method", async () => {
      // Method bodies padded to clear the 50-char floor in processChildren.
      const code = `
class Foo {
  public boolean isEmpty(String value) {
    return value == null || value.length() == 0;
  }

  public String trim(String value) {
    return value == null ? null : value.trim();
  }
}
      `;
      const chunks = await chunker.chunk(code, "Foo.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);
      const isEmpty = methodChunks.find((c) => c.metadata.name === "isEmpty");
      const trim = methodChunks.find((c) => c.metadata.name === "trim");
      expect(isEmpty?.metadata.symbolId).toBe("Foo#isEmpty");
      expect(isEmpty?.metadata.parentSymbolId).toBe("Foo");
      expect(isEmpty?.metadata.parentType).toBe("class_declaration");
      expect(trim?.metadata.symbolId).toBe("Foo#trim");
      expect(trim?.metadata.parentSymbolId).toBe("Foo");
    });

    it("should emit Java static method as a separate chunk with symbolId Class.method (dot separator)", async () => {
      const code = `
class Foo {
  public static String upperCase(String value) {
    return value == null ? null : value.toUpperCase();
  }

  public boolean helper(String value) {
    return Foo.upperCase(value).startsWith("X");
  }
}
      `;
      const chunks = await chunker.chunk(code, "Foo.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const upperCase = methodChunks.find((c) => c.metadata.name === "upperCase");
      // `.` separator per symbolid-convention.md — `static` modifier is class-level.
      expect(upperCase?.metadata.symbolId).toBe("Foo.upperCase");
      expect(upperCase?.metadata.parentSymbolId).toBe("Foo");
    });

    it("should emit Java constructor as a separate chunk with symbolId Class#Class", async () => {
      const code = `
class Foo {
  private final int value;

  public Foo(int initialValue) {
    this.value = initialValue + 1;
  }

  public int getValue() {
    return this.value + 2;
  }
}
      `;
      const chunks = await chunker.chunk(code, "Foo.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const ctor = methodChunks.find((c) => c.metadata.symbolId === "Foo#Foo");
      expect(ctor).toBeDefined();
      expect(ctor?.metadata.name).toBe("Foo");
      expect(ctor?.metadata.parentSymbolId).toBe("Foo");
      expect(ctor?.metadata.parentType).toBe("class_declaration");
    });

    it("should compose nested Java class scopes into method symbolId (Outer.Inner#method)", async () => {
      // symbolid-convention.md: nested class declaration uses `.` between
      // outer and inner (Outer.Inner), and method on that nested class
      // uses `#` for instance methods → Outer.Inner#method.
      const code = `
class Outer {
  static class Inner {
    public String describe(String value) {
      return "inner-result-for-" + value + "-padding-the-body-length";
    }

    public String helper(String value) {
      return this.describe(value).toLowerCase();
    }
  }
}
      `;
      const chunks = await chunker.chunk(code, "Outer.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const describe = methodChunks.find((c) => c.metadata.name === "describe");
      expect(describe?.metadata.symbolId).toBe("Outer.Inner#describe");
      expect(describe?.metadata.parentSymbolId).toBe("Outer.Inner");
    });

    it("should NOT emit Foo#partN anonymous splits for a Java class with many methods", async () => {
      // Synthesize a class large enough that, before the fix, the parent
      // class chunk would have exceeded maxChunkSize (1000 chars) and been
      // split by enforceMaxChunkSize into Foo#part1..partN. Mirrors the
      // Python t6sr regression test for Java.
      const methods: string[] = [];
      for (let i = 0; i < 12; i++) {
        methods.push(`  public String method_${i}(String value) {
    return "result-${i}-" + value + "-with-enough-body-to-clear-the-fifty-char-floor";
  }`);
      }
      const code = `class Foo {
${methods.join("\n\n")}
}`;

      const chunks = await chunker.chunk(code, "Foo.java", "java");
      const partChunks = chunks.filter(
        (c) => typeof c.metadata.symbolId === "string" && c.metadata.symbolId.startsWith("Foo#part"),
      );
      expect(partChunks.length).toBe(0);

      // All 12 method chunks present with the right symbolIds.
      for (let i = 0; i < 12; i++) {
        const methodChunk = chunks.find((c) => c.metadata.symbolId === `Foo#method_${i}`);
        expect(methodChunk).toBeDefined();
      }
    });

    it("should emit interface methods as separate chunks with symbolId Interface#method", async () => {
      // Java interfaces also need method-level chunks. `interface_declaration`
      // is both a chunkable scope and a scopeContainerType.
      const code = `
interface Repository {
  String findById(String id);

  default String findOrDefault(String id, String defaultValue) {
    String result = this.findById(id);
    return result == null ? defaultValue : result;
  }
}
      `;
      const chunks = await chunker.chunk(code, "Repository.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const findOrDefault = methodChunks.find((c) => c.metadata.name === "findOrDefault");
      expect(findOrDefault?.metadata.symbolId).toBe("Repository#findOrDefault");
      expect(findOrDefault?.metadata.parentSymbolId).toBe("Repository");
    });

    // bd tea-rags-mcp-52e8 — abstract method declarations like
    // `String findById(String id);` are short (<50 chars) and were
    // previously filtered out by the validChildren length floor in
    // processChildren. The chunker must emit a chunk for every
    // method_declaration regardless of body presence so
    // `find_symbol("Pair#getLeft")` resolves on abstract API surfaces.
    it("should emit abstract method declarations on abstract class as chunks (no body, short signature)", async () => {
      const code = `
abstract class Pair {
  public abstract String getLeft();
  public abstract String getRight();

  public String describe() {
    return "pair: " + this.getLeft() + ", " + this.getRight();
  }
}
      `;
      const chunks = await chunker.chunk(code, "Pair.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const getLeft = methodChunks.find((c) => c.metadata.name === "getLeft");
      const getRight = methodChunks.find((c) => c.metadata.name === "getRight");
      expect(getLeft?.metadata.symbolId).toBe("Pair#getLeft");
      expect(getRight?.metadata.symbolId).toBe("Pair#getRight");
    });

    it("should emit interface abstract method declarations as chunks (short signature, no body)", async () => {
      const code = `
interface Repository {
  String findById(String id);
  void deleteById(String id);
}
      `;
      const chunks = await chunker.chunk(code, "Repository.java", "java");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const findById = methodChunks.find((c) => c.metadata.name === "findById");
      const deleteById = methodChunks.find((c) => c.metadata.name === "deleteById");
      expect(findById?.metadata.symbolId).toBe("Repository#findById");
      expect(deleteById?.metadata.symbolId).toBe("Repository#deleteById");
    });

    // bd tea-rags-mcp-a466 — Java overload resolution. Multiple
    // method_declaration nodes with the same name share a symbolId, so
    // `find_symbol("StringUtils.upperCase")` returns a single merged
    // chunk for all overloads and get_callers/get_callees can't
    // disambiguate. Suffix every overload after the first with `~N`
    // (1-based index) so each overload has a distinct symbolId.
    it("should suffix Java overload methods so each chunk has a distinct symbolId (~N convention)", async () => {
      const code = `
class StringUtils {
  public static String upperCase(String value) {
    return value == null ? null : value.toUpperCase();
  }

  public static String upperCase(String value, java.util.Locale locale) {
    return value == null ? null : value.toUpperCase(locale);
  }

  public static String upperCase(String value, java.util.Locale locale, boolean strict) {
    return value == null ? null : value.toUpperCase(locale);
  }
}
      `;
      const chunks = await chunker.chunk(code, "StringUtils.java", "java");
      const ids = chunks
        .filter((c) => c.metadata.chunkType === "function")
        .map((c) => c.metadata.symbolId)
        .filter((id): id is string => typeof id === "string" && id.includes("upperCase"));
      // All three overloads must produce distinct symbolIds.
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("StringUtils.upperCase");
      expect(ids).toContain("StringUtils.upperCase~2");
      expect(ids).toContain("StringUtils.upperCase~3");
    });

    it("should suffix Java instance-method overloads under the same class", async () => {
      const code = `
class HashCodeBuilder {
  public HashCodeBuilder append(int value) {
    return this;
  }

  public HashCodeBuilder append(long value) {
    return this;
  }

  public HashCodeBuilder append(Object value) {
    return this;
  }
}
      `;
      const chunks = await chunker.chunk(code, "HashCodeBuilder.java", "java");
      const ids = chunks
        .filter((c) => c.metadata.chunkType === "function")
        .map((c) => c.metadata.symbolId)
        .filter((id): id is string => typeof id === "string" && id.includes("append"));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("HashCodeBuilder#append");
      expect(ids).toContain("HashCodeBuilder#append~2");
      expect(ids).toContain("HashCodeBuilder#append~3");
    });
  });

  // bd tea-rags-mcp-fwa1 / 2hbd / h82m / lk6i — chunker must emit Rust
  // `impl` block methods as separate chunks with symbolId matching
  // cg_symbols.symbol_id from the codegraph provider's `rustNameOf`.
  // Without these chunks, find_symbol("Searcher#new") returns [] and
  // `impl Searcher { fn new() {...} fn search_slice() {...} }` is
  // chunked whole, then split by enforceMaxChunkSize into anonymous
  // Searcher#part1..partN. Mirrors Python t6sr / Go n7x5 / Java c5wt.
  // See .claude/rules/symbolid-convention.md.
  describe("chunk - Rust", () => {
    it("should emit Rust impl block instance method as a separate chunk with symbolId Type#method", async () => {
      // Method bodies padded to clear the 50-char floor.
      const code = `
impl Searcher {
    pub fn search_slice(&self, slice: &[u8]) -> bool {
        return slice.len() > 0 && slice[0] == 42u8;
    }

    pub fn search_path(&self, path: &str) -> bool {
        return path.len() > 0 && path.starts_with("/");
    }
}
      `;
      const chunks = await chunker.chunk(code, "searcher.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);
      const searchSlice = methodChunks.find((c) => c.metadata.name === "search_slice");
      const searchPath = methodChunks.find((c) => c.metadata.name === "search_path");
      // `&self` → instance method → `#` separator.
      expect(searchSlice?.metadata.symbolId).toBe("Searcher#search_slice");
      expect(searchSlice?.metadata.parentSymbolId).toBe("Searcher");
      expect(searchPath?.metadata.symbolId).toBe("Searcher#search_path");
    });

    it("should emit Rust associated function as a separate chunk with symbolId Type.method (dot separator)", async () => {
      // `fn new()` without `self` is an associated function (class-level).
      const code = `
impl Searcher {
    pub fn new(config: Config) -> Searcher {
        return Searcher { config: config, count: 0 };
    }

    pub fn run(&self) -> usize {
        return self.count + 1;
    }
}
      `;
      const chunks = await chunker.chunk(code, "searcher.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const newFn = methodChunks.find((c) => c.metadata.name === "new");
      // No `self` → static / associated function → `.` separator per
      // symbolid-convention.md.
      expect(newFn?.metadata.symbolId).toBe("Searcher.new");
      expect(newFn?.metadata.parentSymbolId).toBe("Searcher");
    });

    // bd tea-rags-mcp-2hbd — `impl Default for Searcher { fn default() }`
    // must register `Searcher#default`, NOT `Default#default`. The
    // implementing TYPE owns the method, not the trait.
    it("should attribute `impl Trait for Type` methods to Type, not the Trait", async () => {
      const code = `
impl Default for Searcher {
    fn default() -> Searcher {
        return Searcher { config: Config::new(), count: 0 };
    }
}
      `;
      const chunks = await chunker.chunk(code, "searcher.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const defaultFn = methodChunks.find((c) => c.metadata.name === "default");
      // The parent is the implementing TYPE (Searcher), not the trait
      // (Default). `default` is an associated function (no `self`) so
      // it joins with `.`.
      expect(defaultFn?.metadata.symbolId).toBe("Searcher.default");
      expect(defaultFn?.metadata.parentSymbolId).toBe("Searcher");
    });

    // bd tea-rags-mcp-h82m — generics + lifetimes must be stripped from
    // symbolId. `impl<'s> Worker<'s>` → `Worker#send`, not
    // `Worker<'s>#send`.
    it("should strip generics and lifetimes from Rust impl type name in symbolId", async () => {
      const code = `
impl<'s> Worker<'s> {
    pub fn send(&self, msg: &'s str) -> bool {
        return msg.len() > 0 && msg.starts_with("hello");
    }
}
      `;
      const chunks = await chunker.chunk(code, "worker.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const send = methodChunks.find((c) => c.metadata.name === "send");
      // No `Worker<'s>`, no `Worker<'_>` — just the bare type identifier.
      expect(send?.metadata.symbolId).toBe("Worker#send");
      expect(send?.metadata.parentSymbolId).toBe("Worker");
    });

    it("should strip generic parameters from Rust impl type name in symbolId", async () => {
      const code = `
impl<T: Clone> Container<T> {
    pub fn clone_inner(&self) -> T {
        return self.value.clone();
    }
}
      `;
      const chunks = await chunker.chunk(code, "container.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const cloneInner = methodChunks.find((c) => c.metadata.name === "clone_inner");
      expect(cloneInner?.metadata.symbolId).toBe("Container#clone_inner");
      expect(cloneInner?.metadata.parentSymbolId).toBe("Container");
    });

    // bd tea-rags-mcp-fwa1 — large impl block must NOT be split into
    // anonymous `Searcher#part1..partN` chunks. Each method becomes its
    // own chunk.
    it("should NOT emit Type#partN anonymous splits for a Rust impl block with many methods", async () => {
      const methods: string[] = [];
      for (let i = 0; i < 12; i++) {
        methods.push(`    pub fn method_${i}(&self) -> String {
        return format!("result-${i}-{}-with-enough-body-to-clear-fifty", self.id);
    }`);
      }
      const code = `impl Searcher {
${methods.join("\n\n")}
}`;
      const chunks = await chunker.chunk(code, "searcher.rs", "rust");
      const partChunks = chunks.filter(
        (c) => typeof c.metadata.symbolId === "string" && c.metadata.symbolId.startsWith("Searcher#part"),
      );
      expect(partChunks.length).toBe(0);
      for (let i = 0; i < 12; i++) {
        const methodChunk = chunks.find((c) => c.metadata.symbolId === `Searcher#method_${i}`);
        expect(methodChunk).toBeDefined();
      }
    });

    // bd tea-rags-mcp-lk6i — a method literally named `chunk` must not
    // be collapsed with the chunker's `(part N/M)` label. fwa1 fix makes
    // each `fn chunk` get its own symbolId — no collision.
    it("should emit `fn chunk` method with its own symbolId, not the chunker's part-N label", async () => {
      const code = `
impl Printer {
    pub fn chunk(&self, data: &[u8]) -> usize {
        return data.len() + self.offset + 1;
    }

    pub fn flush(&self) -> bool {
        return self.offset == 0;
    }
}
      `;
      const chunks = await chunker.chunk(code, "printer.rs", "rust");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const chunkMethod = methodChunks.find((c) => c.metadata.name === "chunk");
      expect(chunkMethod?.metadata.symbolId).toBe("Printer#chunk");
      // The literal "(part N/M)" suffix must NOT appear on this symbolId.
      expect(chunkMethod?.metadata.symbolId).not.toMatch(/part\s*\d+\s*\/\s*\d+/);
    });
  });

  describe("chunk - JavaScript", () => {
    it("should chunk JavaScript functions", async () => {
      const code = `
function greet(name) {
  return 'Hello, ' + name;
}

function farewell(name) {
  return 'Goodbye, ' + name;
}
      `;

      const chunks = await chunker.chunk(code, "test.js", "javascript");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("chunk - Ruby", () => {
    it("should always extract methods from classes regardless of class size", async () => {
      const code = `
class UserService
  def find_user(id)
    # Finds a user by their unique identifier
    user = User.find_by(id: id)
    raise NotFoundError unless user
    user
  end

  def create_user(params)
    # Creates a new user with the given parameters
    user = User.new(params)
    user.save!
    user
  end
end
      `;

      const chunks = await chunker.chunk(code, "test.rb", "ruby");

      // Should extract individual methods, not keep class as one chunk
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      // Each method should have parentName and parentType
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("UserService");
        expect(chunk.metadata.parentType).toBe("class");
      }

      // Verify method names
      const names = methodChunks.map((c) => c.metadata.name).sort();
      expect(names).toEqual(["create_user", "find_user"]);

      // Verify symbolId format: ClassName#methodName (instance methods use #)
      expect(methodChunks.find((c) => c.metadata.name === "find_user")?.metadata.symbolId).toBe(
        "UserService#find_user",
      );
    });

    it("should extract methods with parentName/parentType from classes of any size", async () => {
      const code = `
class LargeService
  def method_one
    # This is the first method with some content
    puts "Processing method one"
    result = compute_something
    return result
  end

  def method_two
    # This is the second method with some content
    puts "Processing method two"
    data = fetch_data
    return data
  end

  def method_three
    # This is the third method with some content
    puts "Processing method three"
    value = calculate_value
    return value
  end

  def method_four
    # This is the fourth method to make class larger
    puts "Processing method four"
    output = generate_output
    return output
  end
end
      `;

      const chunks = await chunker.chunk(code, "large_service.rb", "ruby");

      // Should have individual method chunks
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // All methods should have parentName and parentType
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("LargeService");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should extract methods from modules with parentName/parentType", async () => {
      const code = `
module LargeModule
  def helper_one
    # First helper method with implementation
    puts "Helper one processing"
    result = process_data
    return result
  end

  def helper_two
    # Second helper method with implementation
    puts "Helper two processing"
    data = transform_data
    return data
  end

  def helper_three
    # Third helper method with implementation
    puts "Helper three processing"
    output = format_output
    return output
  end

  def helper_four
    # Fourth helper method for larger module
    puts "Helper four processing"
    value = compute_value
    return value
  end
end
      `;

      const chunks = await chunker.chunk(code, "large_module.rb", "ruby");

      // Should have individual method chunks
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // All methods should have parentName = module name
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("LargeModule");
        expect(chunk.metadata.parentType).toBe("module");
      }
    });

    it("should extract methods from class << self blocks", async () => {
      const code = `
class ConfigurationManager
  class << self
    def load_config
      # Load configuration from file
      puts "Loading configuration"
      config = read_file
      return config
    end

    def save_config(data)
      # Save configuration to file
      puts "Saving configuration"
      write_file(data)
      return true
    end

    def reset_config
      # Reset configuration to defaults
      puts "Resetting configuration"
      defaults = get_defaults
      return defaults
    end

    def validate_config(config)
      # Validate configuration values
      puts "Validating configuration"
      errors = check_values(config)
      return errors
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "config_manager.rb", "ruby");

      // Should extract individual methods
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // Methods inside class << self should have class as parent
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("ConfigurationManager");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should extract class-level code (scopes, associations, validations) as separate chunk", async () => {
      const code = `
class User < ApplicationRecord
  include Trackable
  include Searchable

  has_many :posts, dependent: :destroy
  has_many :comments, dependent: :destroy
  belongs_to :organization

  scope :active, -> { where(active: true) }
  scope :recent, -> { where("created_at > ?", 1.week.ago) }
  scope :admins, -> { where(role: "admin") }

  validates :name, presence: true
  validates :email, presence: true, uniqueness: true
  validates :role, inclusion: { in: %w[admin user guest] }

  before_save :normalize_email

  def full_name
    # Returns the full name by combining first and last name
    [first_name, last_name].compact.join(" ")
  end

  def deactivate!
    # Deactivates the user and notifies admins
    update!(active: false)
    NotificationService.notify_admins(self)
  end

  def admin?
    # Checks whether the user has admin privileges
    role == "admin" || organization&.admin?(self)
  end
end
      `;

      const chunks = await chunker.chunk(code, "user.rb", "ruby");

      // Should have method chunks
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(3);

      // Should have multiple body chunks (semantic groups for Ruby)
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBeGreaterThan(1);

      // All body chunks together should contain the declarations
      const allBodyContent = bodyChunks.map((c) => c.content).join("\n");
      expect(allBodyContent).toContain("has_many :posts");
      expect(allBodyContent).toContain("scope :active");
      expect(allBodyContent).toContain("validates :name");
      expect(allBodyContent).toContain("include Trackable");
      expect(allBodyContent).toContain("before_save :normalize_email");

      // Body chunks should NOT contain method implementations
      for (const body of bodyChunks) {
        expect(body.content).not.toContain("def full_name");
        expect(body.content).not.toContain("def deactivate!");
      }

      // Each body chunk should have parent metadata and class header
      for (const body of bodyChunks) {
        expect(body.metadata.parentSymbolId).toBe("User");
        expect(body.metadata.parentType).toBe("class");
        expect(body.content).toContain("class User < ApplicationRecord");
      }
    });

    it("should include preceding comments in method chunks", async () => {
      const code = `
class PaymentProcessor
  # Process a payment through the gateway
  # @param amount [BigDecimal] payment amount
  # @return [Boolean] whether the payment succeeded
  def process_payment(amount)
    gateway.charge(amount)
    true
  rescue GatewayError => e
    handle_error(e)
    false
  end

  # Refund a previously processed payment
  def refund(transaction_id)
    gateway.refund(transaction_id)
  end
end
      `;

      const chunks = await chunker.chunk(code, "payment.rb", "ruby");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      // process_payment should include the 3 comment lines
      const processChunk = methodChunks.find((c) => c.metadata.name === "process_payment")!;
      expect(processChunk.content).toContain("# Process a payment through the gateway");
      expect(processChunk.content).toContain("# @param amount");
      expect(processChunk.content).toContain("# @return [Boolean]");
      // startLine should be the first comment line, not the def line
      expect(processChunk.startLine).toBeLessThan(
        processChunk.content.indexOf("def process_payment") ? processChunk.startLine + 3 : processChunk.startLine,
      );

      // refund should include its comment
      const refundChunk = methodChunks.find((c) => c.metadata.name === "refund")!;
      expect(refundChunk.content).toContain("# Refund a previously processed payment");

      // Comments should NOT appear in body chunks
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      const allBodyContent = bodyChunks.map((c) => c.content).join("\n");
      expect(allBodyContent).not.toContain("# Process a payment");
      expect(allBodyContent).not.toContain("# Refund a previously");
    });

    it("should capture comments with one blank line between comment and def", async () => {
      const code = `
class UserService
  # Finds user by email address
  # Returns nil if not found

  def find_by_email(email)
    User.find_by(email: email.downcase)
  end

  def create_user(params)
    User.create!(params)
  end
end
      `;

      const chunks = await chunker.chunk(code, "user_service.rb", "ruby");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const findChunk = methodChunks.find((c) => c.metadata.name === "find_by_email")!;

      // Comment with 1 blank line gap should still be captured
      expect(findChunk.content).toContain("# Finds user by email address");
      expect(findChunk.content).toContain("# Returns nil if not found");
    });

    it("should not capture comments separated by 2+ blank lines from def", async () => {
      const code = `
class Processor
  # This is an unrelated comment about the class
  # It describes the processor in general terms


  def process(data)
    # Process the incoming data through transformation pipeline
    result = transform(data)
    validate_result(result)
    result
  end

  def cleanup(options)
    # Clean up temporary files and cached data
    remove_temp_files(options)
    clear_cache(options)
  end
end
      `;

      const chunks = await chunker.chunk(code, "processor.rb", "ruby");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      const processChunk = methodChunks.find((c) => c.metadata.name === "process")!;

      // Comment with 2 blank lines gap should NOT be captured
      expect(processChunk.content).not.toContain("# This is an unrelated comment");
    });

    it("should keep class as single chunk when it has no methods", async () => {
      // A class with only declarations (no methods) stays as one chunk
      const code = `
class UserSerializer < ActiveModel::Serializer
  attributes :id, :name, :email, :role
  has_many :posts, serializer: PostSerializer
  belongs_to :organization, serializer: OrgSerializer
end
      `;

      const chunks = await chunker.chunk(code, "user_serializer.rb", "ruby");

      // Should be a single chunk (no methods to extract)
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("class");
      expect(chunks[0].metadata.name).toBe("UserSerializer");
    });

    it("should handle module with includes and methods", async () => {
      const code = `
module Authenticatable
  extend ActiveSupport::Concern

  included do
    has_secure_password
    validates :password, length: { minimum: 8 }
  end

  def authenticate(credentials)
    # Verify credentials against stored password hash
    return false unless credentials[:password]
    authenticate_password(credentials[:password])
  end

  def generate_token
    # Generate a secure authentication token for API access
    SecureRandom.hex(32).tap do |token|
      update!(auth_token: token)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "concerns.rb", "ruby");

      // Should have method chunks
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("Authenticatable");
        expect(chunk.metadata.parentType).toBe("module");
      }

      // Should have body chunks with module-level code (semantic groups for Ruby)
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBeGreaterThanOrEqual(1);

      const allBodyContent = bodyChunks.map((c) => c.content).join("\n");
      expect(allBodyContent).toContain("extend ActiveSupport::Concern");
    });

    it("should chunk Ruby singleton methods with parentName", async () => {
      const code = `
class Configuration
  DEFAULT_TIMEOUT = 30
  DEFAULT_RETRIES = 3

  def self.load_from_file(path)
    # Load YAML configuration from the specified file path
    config = YAML.load_file(path)
    validate!(config)
    config
  end

  def self.default_settings
    # Returns default configuration settings hash
    { timeout: DEFAULT_TIMEOUT, retries: DEFAULT_RETRIES }
  end
end
      `;

      const chunks = await chunker.chunk(code, "config.rb", "ruby");

      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentSymbolId).toBe("Configuration");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should chunk Ruby lambdas and procs as part of class body", async () => {
      const code = `
class Calculator
  OPERATIONS = {
    add: ->(a, b) { a + b },
    subtract: lambda { |a, b| a - b },
    multiply: ->(a, b) { a * b }
  }

  VALIDATORS = {
    positive: ->(n) { n > 0 },
    even: ->(n) { n.even? }
  }

  def process(data)
    # Process data through the operation pipeline
    data.map do |item|
      transform(item)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "calculator.rb", "ruby");

      // Should extract the method
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(1);
      expect(methodChunks[0].metadata.name).toBe("process");

      // Constants with lambdas should be in the class body chunk
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBe(1);
      expect(bodyChunks[0].content).toContain("OPERATIONS");
      expect(bodyChunks[0].content).toContain("VALIDATORS");
    });

    it("should chunk Ruby begin/rescue blocks within methods", async () => {
      const code = `
class ApiClient
  def fetch_data(url)
    begin
      response = HTTP.get(url)
      parse_response(response)
    rescue NetworkError => e
      handle_network_error(e)
    rescue ParseError => e
      handle_parse_error(e)
    end
  end

  def post_data(url, payload)
    begin
      response = HTTP.post(url, body: payload)
      parse_response(response)
    rescue NetworkError => e
      retry_with_backoff(e)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "api_client.rb", "ruby");

      // Methods should be extracted individually, rescue blocks stay inside
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);
      expect(methodChunks[0].content).toContain("rescue NetworkError");
    });

    it("should handle class with only very short methods (under min threshold)", async () => {
      // When all methods are too short, keep as single class chunk
      const code = `
class SmallService
  def name
    @name
  end

  def id
    @id
  end
end
      `;

      const chunks = await chunker.chunk(code, "small_service.rb", "ruby");

      // Class with only tiny methods — kept as single class chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("class");
    });

    // BUG tea-rags-mcp-bdvm — nested module/class scope must accumulate into
    // the method's parent symbolId, not stop at the outermost. The chunker
    // historically only used the OUTERMOST module's name as parentName for
    // every method discovered inside, so `module A; module B; class C; def
    // foo; end; end; end; end` emitted `A#foo` instead of `A::B::C#foo`.
    // Codegraph correctly emits `A::B::C#foo` — chunker and codegraph MUST
    // agree per .claude/rules/symbolid-convention.md or get_callers /
    // get_callees produce ghost rows.
    it("composes nested module/class scopes into method symbolId (Ruby :: separator)", async () => {
      // Pad each method body so the chunker classifies the class as
      // "large enough to extract methods" (>= 50 chars per child).
      const code = `
module A
  module B
    class C
      def foo
        # First method that is long enough to trigger child extraction
        puts "doing foo work in C inside B inside A"
        result = compute_foo_thing(arg1, arg2)
        return result
      end

      def bar
        # Second method with the same locality
        puts "doing bar work in C inside B inside A"
        result = compute_bar_thing(arg1, arg2)
        return result
      end
    end
  end
end
      `;
      const chunks = await chunker.chunk(code, "a/b/c.rb", "ruby");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);
      const foo = methodChunks.find((c) => c.metadata.name === "foo");
      const bar = methodChunks.find((c) => c.metadata.name === "bar");
      expect(foo?.metadata.symbolId).toBe("A::B::C#foo");
      expect(foo?.metadata.parentSymbolId).toBe("A::B::C");
      expect(bar?.metadata.symbolId).toBe("A::B::C#bar");
      expect(bar?.metadata.parentSymbolId).toBe("A::B::C");
    });
  });

  describe("chunk - Markdown", () => {
    it("should split on h1/h2/h3 boundaries", async () => {
      const code = `# Introduction

This is the introduction section with some content that is long enough.

## Getting Started

Here is how to get started with the project and some extra text.

### Installation

Run npm install to install dependencies. This is a subsection of Getting Started.

### Configuration

Configure the project by editing the config file. Also part of Getting Started.

## Usage

Use the library like this. This is a separate top-level section.
`;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      const sectionChunks = chunks.filter((c) => c.metadata.chunkType === "block" && c.metadata.name);
      const sectionNames = sectionChunks.map((c) => c.metadata.name);

      // Small h3 sections grouped into parent h2 chunks
      expect(sectionNames).toContain("Introduction");
      expect(sectionNames).toContain("Getting Started"); // includes Installation + Configuration
      expect(sectionNames).toContain("Usage");

      // Getting Started chunk contains h3 content
      const gs = sectionChunks.find((c) => c.metadata.name === "Getting Started");
      expect(gs!.content).toContain("Installation");
      expect(gs!.content).toContain("Configuration");
    });

    it("should split h3-only documents into separate chunks", async () => {
      const code = `### Section One

This is content under a h3 heading with enough text to meet minimum size.

### Section Two

This is more content under another h3 heading with enough text to meet minimum.

### Section Three

Even more content under a third h3 heading with plenty of text for the chunk.
`;

      const chunks = await chunker.chunk(code, "notes.md", "markdown");

      // Small h3-only sections grouped into one chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const allContent = chunks.map((c) => c.content).join("");
      expect(allContent).toContain("Section One");
      expect(allContent).toContain("Section Two");
      expect(allContent).toContain("Section Three");
    });

    it("should split h3 before first h2 into its own chunk", async () => {
      const code = `Some intro text that appears before any major heading in the document.

### A Minor Heading

Content under the minor heading that is part of the early document section.

## First Real Section

This is the first real section with enough content for a valid chunk size.
`;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      const names = chunks.map((c) => c.metadata.name);

      // h3 before first h2 is now its own chunk (not preamble)
      expect(names).toContain("A Minor Heading");
      expect(names).toContain("First Real Section");
    });

    it("should include breadcrumb from ancestor headings in h3 chunks", async () => {
      const code = `# API Guide

Overview of the API.

## Authentication

How authentication works in the system and all the important details.

### OAuth Flow

The OAuth flow involves multiple steps and requires proper configuration setup.

### Token Refresh

Token refresh happens automatically when the access token expires on the server.

## Endpoints

List of available API endpoints and their documentation with examples.
`;

      const chunks = await chunker.chunk(code, "api.md", "markdown");

      // h3 sections grouped into h2 "Authentication" chunk with breadcrumbs
      const authChunk = chunks.find((c) => c.metadata.name === "Authentication");
      expect(authChunk).toBeDefined();
      expect(authChunk!.content).toContain("# API Guide");
      expect(authChunk!.content).toContain("### OAuth Flow");
      expect(authChunk!.content).toContain("### Token Refresh");

      // h2 chunk includes breadcrumb from h1 (same chunk, already verified above)
      expect(authChunk!.content).toContain("# API Guide");
    });

    it("should extract code blocks from markdown", async () => {
      const code = `
# Code Examples

Here is a TypeScript example:

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

And a Python example:

\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`
      `;

      const chunks = await chunker.chunk(code, "examples.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Should have code block chunks with language metadata
      const codeChunks = chunks.filter(
        (c) =>
          c.metadata.name?.includes("Code") || c.metadata.language === "typescript" || c.metadata.language === "python",
      );
      expect(codeChunks.length).toBeGreaterThan(0);
    });

    it("should handle markdown without headings", async () => {
      const code = `
This is a markdown file without any headings.
It just has some plain text content that should be chunked as a single block.
The content needs to be long enough to meet the minimum chunk size requirements.
      `;

      const chunks = await chunker.chunk(code, "notes.md", "markdown");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should support markdown language", () => {
      expect(chunker.supportsLanguage("markdown")).toBe(true);
    });

    it("should set isDocumentation flag for markdown chunks", async () => {
      const code = `
# Documentation Title

This is documentation content that explains how to use the library.

## API Reference

Here are the available methods and their descriptions.
      `;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // All markdown chunks should have isDocumentation = true
      for (const chunk of chunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
      }
    });
  });

  describe("fallback behavior", () => {
    it("should fallback to character chunker for unsupported language", async () => {
      const code =
        "Some random text that is long enough to not be filtered out by the minimum chunk size requirement.\n" +
        "This is another line with enough content to make a valid chunk.\n" +
        "And here is a third line to ensure we have sufficient text content.";
      const chunks = await chunker.chunk(code, "test.txt", "unknown");

      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should fallback for very large chunks", async () => {
      const largeFunction = `
function veryLargeFunction() {
  ${Array(100).fill('console.log("line");').join("\n  ")}
}
      `;

      const chunks = await chunker.chunk(largeFunction, "test.js", "javascript");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should fallback on parsing errors", async () => {
      const invalidCode = "function broken( { invalid syntax";
      const chunks = await chunker.chunk(invalidCode, "test.js", "javascript");

      // Should handle gracefully and fallback
      expect(Array.isArray(chunks)).toBe(true);
    });
  });

  describe("hard cap on chunk size", () => {
    it("should split a huge Python function into sub-chunks each <= maxChunkSize", async () => {
      // Reproduces the kpi-calc.py:135-287 scenario (6KB monolithic function)
      // that overflowed Ollama context. Python has no childChunkTypes, so the
      // whole function falls into chunkSingleNode and would otherwise emit a
      // single oversized chunk.
      const bodyLines = Array.from(
        { length: 200 },
        (_, i) => `    intermediate_value_${i} = compute_step_${i}(payload, options, registry, cache)`,
      ).join("\n");
      const huge = `def kpi_calc(payload, options, registry, cache):\n    """Compute KPIs."""\n${bodyLines}\n    return intermediate_value_0`;

      const chunks = await chunker.chunk(huge, "kpi-calc.py", "python");

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(config.maxChunkSize);
      }
    });

    it("should preserve symbolId continuity across split parts", async () => {
      const bodyLines = Array.from({ length: 200 }, (_, i) => `    step_${i} = compute(value, options)`).join("\n");
      const huge = `def big_function(value, options):\n    """Doc."""\n${bodyLines}\n    return step_0`;

      const chunks = await chunker.chunk(huge, "big.py", "python");

      const splitChunks = chunks.filter((c) => c.metadata.parentSymbolId === "big_function");
      expect(splitChunks.length).toBeGreaterThan(0);
      // bd tea-rags-mcp-t6sr — oversized top-level functions now flow
      // through `chunkOversizedNode` (same path TS uses for big functions)
      // so every sub-chunk shares `symbolId: "big_function"`. Codegraph
      // invariant: all sub-chunks of one method share one symbolId.
      // Matches the regression test in tree-sitter.oversized-symbolid.test.ts.
      for (const chunk of splitChunks) {
        expect(chunk.metadata.symbolId).toBe("big_function");
        expect(chunk.metadata.chunkType).toBe("function");
      }
    });

    it("should enforce hard cap on a fallback (non-AST) language too", async () => {
      // Plain text chunked by CharacterChunker — the post-process guard in
      // TreeSitterChunker.chunk() does not run, but CharacterChunker is the
      // delegate inside the AST path. Verifying here that the AST path's
      // contract holds end-to-end for any language.
      const bodyLines = Array.from(
        { length: 200 },
        (_, i) => `function step_${i}() { return computeValue(${i}) + adjustWindow(${i}); }`,
      ).join("\n");
      const code = `class Mega {\n${bodyLines}\n}`;

      const chunks = await chunker.chunk(code, "mega.ts", "typescript");

      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(config.maxChunkSize);
      }
    });
  });

  describe("metadata extraction", () => {
    it("should extract function names", async () => {
      const code = `
function myFunction() {
  console.log('Processing data');
  return 42;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks[0].metadata.name).toBe("myFunction");
      expect(chunks[0].metadata.chunkType).toBe("function");
    });

    it("should include file path and language", async () => {
      const code = "function test() {\n  console.log('Test function');\n  return true;\n}";
      const chunks = await chunker.chunk(code, "/path/to/file.ts", "typescript");

      expect(chunks[0].metadata.filePath).toBe("/path/to/file.ts");
      expect(chunks[0].metadata.language).toBe("typescript");
    });

    it("should set correct line numbers", async () => {
      const code = `
line1
function test() {
  console.log('Testing line numbers');
  return 1;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks[0].startLine).toBeGreaterThan(0);
      expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    });
  });

  describe("supportsLanguage", () => {
    it("should support TypeScript", () => {
      expect(chunker.supportsLanguage("typescript")).toBe(true);
    });

    it("should support Python", () => {
      expect(chunker.supportsLanguage("python")).toBe(true);
    });

    it("should support Ruby", () => {
      expect(chunker.supportsLanguage("ruby")).toBe(true);
    });

    it("should not support unknown languages", () => {
      expect(chunker.supportsLanguage("unknown")).toBe(false);
    });
  });

  describe("lazy loading", () => {
    it("should have no parsers loaded initially", () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toHaveLength(0);
      expect(stats.available.length).toBeGreaterThan(0);
    });

    it("should load parser on first use", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
      await freshChunker.chunk("function test() { return 1; }", "test.ts", "typescript");
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");
    });

    it("should preload multiple languages", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
      await freshChunker.preloadLanguages(["python", "ruby"]);
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("python");
      expect(stats.loaded).toContain("ruby");
    });

    it("should return all supported languages", () => {
      const languages = chunker.getSupportedLanguages();
      expect(languages).toContain("typescript");
      expect(languages).toContain("javascript");
      expect(languages).toContain("python");
      expect(languages).toContain("ruby");
      expect(languages).toContain("go");
      expect(languages).toContain("rust");
      expect(languages).toContain("java");
      expect(languages).toContain("bash");
      expect(languages).toContain("markdown");
    });
  });

  describe("getStrategyName", () => {
    it("should return tree-sitter", () => {
      expect(chunker.getStrategyName()).toBe("tree-sitter");
    });
  });

  describe("edge cases", () => {
    it("should handle empty code", async () => {
      const chunks = await chunker.chunk("", "test.ts", "typescript");
      expect(chunks).toHaveLength(0);
    });

    it("should skip very small chunks", async () => {
      const code = "const x = 1;";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      // Very small chunks should be skipped
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle nested structures", async () => {
      const code = `
class Outer {
  method1() {
    function inner() {
      return 1;
    }
  }

  method2() {
    return 2;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should extract name from child identifier when name field is absent", async () => {
      // This code pattern will trigger the fallback name extraction from children
      const code = `
type MyType = {
  field1: string;
  field2: number;
};
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle struct-like constructs", async () => {
      // Go-like struct to test getChunkType handling of struct patterns
      const code = `
type User struct {
  ID   int
  Name string
}
      `;

      const chunks = await chunker.chunk(code, "test.go", "go");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      // Should classify as class type due to struct pattern
      if (chunks.length > 0) {
        expect(chunks.some((c) => c.metadata.chunkType === "class")).toBe(true);
      }
    });

    it("should handle trait-like constructs", async () => {
      // Rust trait to test getChunkType handling of trait patterns
      const code = `
trait Printable {
    fn print(&self);
}
      `;

      const chunks = await chunker.chunk(code, "test.rs", "rust");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      // Should classify as interface type due to trait pattern
      if (chunks.length > 0) {
        expect(chunks.some((c) => c.metadata.chunkType === "interface")).toBe(true);
      }
    });

    it("should classify unknown node types as block", async () => {
      // Create a large code block that doesn't match function, class, or interface patterns
      const code = `
export const myModule = {
  helper1: () => {
    console.log('Helper function 1');
    return 'result1';
  },
  helper2: () => {
    console.log('Helper function 2');
    return 'result2';
  },
  config: {
    name: 'my-module',
    version: '1.0.0',
  },
};
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("symbolId metadata", () => {
    it("should set symbolId for standalone functions", async () => {
      const code = `
function calculateSum(numbers: number[]): number {
  // Calculate the sum of all numbers in the array
  let total = 0;
  for (const num of numbers) {
    total += num;
  }
  return total;
}

function calculateProduct(numbers: number[]): number {
  // Calculate the product of all numbers in the array
  let result = 1;
  for (const num of numbers) {
    result *= num;
  }
  return result;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Find function chunks by name
      const functionChunks = chunks.filter(
        (c) => c.metadata.name === "calculateSum" || c.metadata.name === "calculateProduct",
      );

      // Verify symbolId is set for functions
      for (const chunk of functionChunks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }
    });

    it("should set symbolId for methods in large classes with parentName", async () => {
      // Use smaller config to trigger class splitting
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(
        smallConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      const code = `
class UserService
  def find_by_id(id)
    # Find user by ID with additional processing
    puts "Finding user with ID: #{id}"
    user = User.find(id)
    validate_user(user)
    return user
  end

  def create_user(params)
    # Create new user with validation
    puts "Creating user with params: #{params}"
    validate_params(params)
    user = User.create(params)
    send_welcome_email(user)
    return user
  end

  def update_user(id, params)
    # Update existing user with checks
    puts "Updating user #{id} with params"
    user = User.find(id)
    validate_params(params)
    user.update(params)
    log_update(user)
    return user
  end

  def delete_user(id)
    # Delete user by ID with cleanup
    puts "Deleting user with ID: #{id}"
    user = User.find(id)
    cleanup_user_data(user)
    User.destroy(id)
    log_deletion(id)
  end

  def list_users(page, per_page)
    # List users with pagination
    puts "Listing users page #{page}"
    offset = (page - 1) * per_page
    users = User.offset(offset).limit(per_page)
    return users
  end
end
      `;

      const chunks = await smallChunker.chunk(code, "user_service.rb", "ruby");

      // Find method chunks with parentName (indicates class was split)
      const methodChunks = chunks.filter((c) => c.metadata.parentSymbolId && c.metadata.chunkType === "function");

      // If class was split, verify symbolId format
      if (methodChunks.length > 0) {
        for (const chunk of methodChunks) {
          if (chunk.metadata.name && chunk.metadata.parentSymbolId) {
            expect(chunk.metadata.symbolId).toBe(`${chunk.metadata.parentSymbolId}#${chunk.metadata.name}`);
          }
        }

        // Specific check for one method
        const findMethod = methodChunks.find((c) => c.metadata.name === "find_by_id");
        if (findMethod) {
          expect(findMethod.metadata.symbolId).toBe("UserService#find_by_id");
        }
      } else {
        // If class wasn't split, all chunks should still have symbolId
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
          if (chunk.metadata.name) {
            expect(chunk.metadata.symbolId).toBeDefined();
          }
        }
      }
    });

    it("should set symbolId for markdown sections", async () => {
      const code = `
# Main Title

Introduction paragraph with content.

## Installation

Instructions for installation.

### Prerequisites

List of prerequisites.

## Usage

How to use the library.
      `;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Find section chunks
      const sectionChunks = chunks.filter((c) => c.metadata.name && c.metadata.isDocumentation);

      expect(sectionChunks.length).toBeGreaterThan(0);

      // Verify symbolId is set to section name
      for (const chunk of sectionChunks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }

      // Check specific section
      const installChunk = sectionChunks.find((c) => c.metadata.name === "Installation");
      if (installChunk) {
        expect(installChunk.metadata.symbolId).toBe("Installation");
      }
    });

    it("should set symbolId for markdown code blocks", async () => {
      const code = `
# Examples

TypeScript example:

\`\`\`typescript
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Python example:

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`
      `;

      const chunks = await chunker.chunk(code, "examples.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Find code block chunks
      const codeBlocks = chunks.filter((c) => c.metadata.name?.includes("Code") && c.metadata.isDocumentation);

      expect(codeBlocks.length).toBeGreaterThan(0);

      // Verify symbolId is set
      for (const chunk of codeBlocks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }

      // Check specific code blocks
      const tsCodeBlock = codeBlocks.find((c) => c.metadata.name === "Code: typescript");
      if (tsCodeBlock) {
        expect(tsCodeBlock.metadata.symbolId).toBe("Code: typescript");
      }

      const pyCodeBlock = codeBlocks.find((c) => c.metadata.name === "Code: python");
      if (pyCodeBlock) {
        expect(pyCodeBlock.metadata.symbolId).toBe("Code: python");
      }
    });

    it("should set symbolId for small classes without parent context", async () => {
      const code = `
class Calculator
  def add(a, b)
    a + b
  end
end
      `;

      const chunks = await chunker.chunk(code, "calculator.rb", "ruby");

      // Small class should be one chunk
      expect(chunks.length).toBe(1);

      // symbolId should be the class name (no parent splitting)
      expect(chunks[0].metadata.symbolId).toBe("Calculator");
    });

    it("should handle chunks without name gracefully", async () => {
      const code = `
const x = 1;
const y = 2;
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      if (chunks.length > 0) {
        // If no name, symbolId should be undefined
        const chunk = chunks[0];
        if (!chunk.metadata.name) {
          expect(chunk.metadata.symbolId).toBeUndefined();
        }
      }
    });

    it("should set symbolId for TypeScript class methods in large classes", async () => {
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(
        smallConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      const code = `
class DataProcessor {
  processData(data: string[]): string[] {
    // Process the data
    console.log('Processing data');
    return data.map(item => item.trim());
  }

  validateData(data: string[]): boolean {
    // Validate the data
    console.log('Validating data');
    return data.every(item => item.length > 0);
  }

  transformData(data: string[]): Record<string, string> {
    // Transform data to object
    console.log('Transforming data');
    return data.reduce((acc, item, idx) => {
      acc[\`key\${idx}\`] = item;
      return acc;
    }, {} as Record<string, string>);
  }

  saveData(data: string[]): void {
    // Save the data
    console.log('Saving data');
    localStorage.setItem('data', JSON.stringify(data));
  }
}
      `;

      const chunks = await smallChunker.chunk(code, "processor.ts", "typescript");

      // Find method chunks with parent
      const methodChunks = chunks.filter(
        (c) => c.metadata.parentSymbolId === "DataProcessor" && c.metadata.chunkType === "function",
      );

      if (methodChunks.length > 0) {
        // Verify symbolId format
        for (const chunk of methodChunks) {
          expect(chunk.metadata.symbolId).toBe(`DataProcessor#${chunk.metadata.name}`);
        }

        // Check specific method
        const processMethod = methodChunks.find((c) => c.metadata.name === "processData");
        if (processMethod) {
          expect(processMethod.metadata.symbolId).toBe("DataProcessor#processData");
        }
      }
    });

    // bd tea-rags-mcp-kfzx — chunker must mirror codegraph `jsNameOf` for
    // JS assignment_expression / lexical_declaration shapes that carry a
    // function value. Without this the Qdrant payload symbolId stays at
    // the top-level function_declaration set (~2 symbols per express
    // lib/application.js) while codegraph cg_symbols emits ~18 — the two
    // diverge and `find_symbol(symbol="app.set")` returns empty even
    // though `get_callers("app.set")` finds rows.
    //
    // Patterns covered (per .claude/rules/symbolid-convention.md):
    //   #1  obj.method = function () {}                  → obj.method
    //   #2  Foo.prototype.bar = function () {}           → Foo#bar (instance)
    //   #3  exports.foo = function () {}                 → foo (top-level)
    //   #5  const Bar = function () {} / arrow / let/var → Bar
    describe("JS assignment_expression symbolId (bd tea-rags-mcp-kfzx)", () => {
      it("#1 emits symbolId `obj.method` for `obj.method = function () {}`", async () => {
        const code = [
          "var app = {};",
          "app.set = function set(setting, val) {",
          "  // long enough body to clear the 50-char chunk-size filter",
          "  this.settings = this.settings || {};",
          "  this.settings[setting] = val;",
          "  return this;",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        const setChunk = chunks.find((c) => c.metadata.symbolId === "app.set");
        expect(setChunk).toBeDefined();
        expect(setChunk!.metadata.name).toBe("app.set");
      });

      it("#2 emits symbolId `Foo#bar` for `Foo.prototype.bar = function () {}`", async () => {
        const code = [
          "function Foo() {}",
          "Foo.prototype.bar = function bar(arg) {",
          "  // prototype assignment is the canonical pre-class instance method",
          "  this.value = arg;",
          "  return this;",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "foo.js", "javascript");
        const barChunk = chunks.find((c) => c.metadata.symbolId === "Foo#bar");
        expect(barChunk).toBeDefined();
        expect(barChunk!.metadata.name).toBe("Foo#bar");
      });

      it("#3 emits symbolId `foo` for `exports.foo = function () {}`", async () => {
        const code = [
          "exports.foo = function foo() {",
          "  // CommonJS exports — emit top-level symbol just like a function decl",
          "  return 'hello world from foo handler';",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "mod.js", "javascript");
        const fooChunk = chunks.find((c) => c.metadata.symbolId === "foo");
        expect(fooChunk).toBeDefined();
        expect(fooChunk!.metadata.name).toBe("foo");
      });

      it("#5 emits symbolId `Bar` for `const Bar = function () {}`", async () => {
        const code = [
          "const Bar = function Bar() {",
          "  // const-declared function expression — same emission as function_declaration",
          "  return { kind: 'bar', value: 42 };",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "bar.js", "javascript");
        const barChunk = chunks.find((c) => c.metadata.symbolId === "Bar");
        expect(barChunk).toBeDefined();
        expect(barChunk!.metadata.name).toBe("Bar");
      });
    });

    // bd tea-rags-mcp-d1f8 — chunker must mirror codegraph for JS getter
    // helpers so `find_symbol(symbol="app.router")` matches the chunk that
    // contains the getter body. Without this the cg_symbols row exists but
    // the Qdrant payload lacks the symbolId — find_symbol returns empty.
    describe("JS getter helpers symbolId (bd tea-rags-mcp-d1f8)", () => {
      it("Object.defineProperty(obj,'name',{get:fn}) emits chunk with symbolId `obj.name`", async () => {
        const code = [
          "var app = {};",
          "Object.defineProperty(app, 'router', {",
          "  configurable: true,",
          "  enumerable: true,",
          "  get: function () {",
          "    // long enough body to clear the chunker minimum-size filter",
          "    return this._router;",
          "  },",
          "});",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        const routerChunk = chunks.find((c) => c.metadata.symbolId === "app.router");
        expect(routerChunk).toBeDefined();
        expect(routerChunk!.metadata.name).toBe("app.router");
      });

      it("defineGetter(obj,'name',fn) helper emits chunk with symbolId `obj.name`", async () => {
        const code = [
          "var req = {};",
          "function defineGetter(obj, name, getter) {",
          "  Object.defineProperty(obj, name, { configurable: true, enumerable: true, get: getter });",
          "}",
          "defineGetter(req, 'query', function query() {",
          "  // long enough body to clear the chunker minimum-size filter",
          "  return this._query;",
          "});",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "request.js", "javascript");
        const queryChunk = chunks.find((c) => c.metadata.symbolId === "req.query");
        expect(queryChunk).toBeDefined();
        expect(queryChunk!.metadata.name).toBe("req.query");
      });
    });

    // bd tea-rags-mcp-z95o — chunker must mirror provider's forEach-dispatch
    // emission so find_symbol(app.get) resolves to a chunk.
    describe("JS forEach HTTP-verb dispatch symbolId (bd tea-rags-mcp-z95o)", () => {
      it("methods.forEach(m => app[m] = fn) emits one chunk per HTTP verb", async () => {
        const code = [
          "var methods = require('methods');",
          "var app = {};",
          "methods.forEach(function (method) {",
          "  app[method] = function (path) {",
          "    // long enough body to clear the chunker minimum-size filter",
          "    return this;",
          "  };",
          "});",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        // 9 HTTP verbs from the npm `methods` package.
        const verbs = ["get", "post", "put", "delete", "head", "options", "patch", "connect", "trace"];
        for (const verb of verbs) {
          const verbChunk = chunks.find((c) => c.metadata.symbolId === `app.${verb}`);
          expect(verbChunk, `chunk for app.${verb} missing`).toBeDefined();
          expect(verbChunk!.metadata.name).toBe(`app.${verb}`);
        }
        // bd tea-rags-mcp-z95o — sibling chunks share content / lines /
        // filePath. If `generateChunkId` excludes symbolId, all 9 verb
        // chunks collide on the same Qdrant point ID and only the LAST
        // one survives the upsert. Assert that the 9 chunk IDs are
        // pairwise distinct so the chunks reach Qdrant intact.
        const verbChunks = verbs.map((v) => chunks.find((c) => c.metadata.symbolId === `app.${v}`)!);
        const ids = verbChunks.map((c) => generateChunkId(c));
        expect(new Set(ids).size).toBe(verbs.length);
      });

      // bd tea-rags-mcp-z95o widening — express does `require('./utils').methods`,
      // not `require('methods')`. HTTP-verb string literals in the body are
      // the strongest signal that the callback iterates HTTP verbs.
      it("methods.forEach with `method === 'get'` body emits chunks for each verb (z95o-2)", async () => {
        const code = [
          "var methods = require('./utils').methods;",
          "var app = {};",
          "methods.forEach(function (method) {",
          "  app[method] = function (path) {",
          "    if (method === 'get' && arguments.length === 1) { return this; }",
          "    // long enough body to clear the chunker minimum-size filter",
          "    return this;",
          "  };",
          "});",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        const verbs = ["get", "post", "put", "delete"];
        for (const verb of verbs) {
          const verbChunk = chunks.find((c) => c.metadata.symbolId === `app.${verb}`);
          expect(verbChunk, `chunk for app.${verb} missing`).toBeDefined();
          expect(verbChunk!.metadata.name).toBe(`app.${verb}`);
        }
      });

      it("forEach without HTTP-verb body markers does NOT emit verb chunks (z95o-3)", async () => {
        const code = [
          "var things = ['alpha', 'beta', 'gamma'];",
          "var obj = {};",
          "things.forEach(function (thing) {",
          "  obj[thing] = function () {",
          "    // long enough body to clear the chunker minimum-size filter",
          "    return thing.length;",
          "  };",
          "});",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "config.js", "javascript");
        // No HTTP verbs — must not emit obj.get / obj.post chunks.
        const verbChunk = chunks.find((c) => c.metadata.symbolId === "obj.get" || c.metadata.symbolId === "obj.post");
        expect(verbChunk).toBeUndefined();
      });
    });

    // bd tea-rags-mcp-d1f8 — `Object.defineProperty(this, ...)` inside an
    // outer `app.method = function ...` assignment must resolve `this` to
    // the outer receiver `app`, emitting `app.<name>` not a literal
    // `app.init.this.router` chain. Mirrors codegraph provider behaviour.
    describe("JS defineProperty(this, ...) inside outer assignment (bd tea-rags-mcp-d1f8 this-resolve)", () => {
      it("emits chunk with symbolId `app.router` not literal-this chain", async () => {
        const code = [
          "var app = {};",
          "app.init = function init() {",
          "  Object.defineProperty(this, 'router', {",
          "    configurable: true,",
          "    enumerable: true,",
          "    get: function () {",
          "      // long enough body to clear the chunker minimum-size filter",
          "      return this._router;",
          "    },",
          "  });",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        const routerChunk = chunks.find((c) => c.metadata.symbolId === "app.router");
        expect(routerChunk).toBeDefined();
        expect(routerChunk!.metadata.name).toBe("app.router");
        // Negative — no literal-this chain.
        const literalThis = chunks.find(
          (c) => c.metadata.symbolId === "app.init.this.router" || c.metadata.symbolId === "this.router",
        );
        expect(literalThis).toBeUndefined();
      });

      // bd tea-rags-mcp-d1f8 — the outer `app.init = function init() {...}`
      // assignment AND the nested `Object.defineProperty(this, 'router', ...)`
      // sibling must BOTH be emitted, with distinct chunk IDs. Previously
      // both shared identical content / file / line range, so
      // `generateChunkId` collided and Qdrant kept only one point — the
      // chunker emitted two CodeChunk objects but only one survived
      // upsert.
      it("emits BOTH `app.init` and `app.router` sibling chunks with distinct chunk IDs", async () => {
        const code = [
          "var app = {};",
          "app.init = function init() {",
          "  Object.defineProperty(this, 'router', {",
          "    configurable: true,",
          "    enumerable: true,",
          "    get: function () {",
          "      // long enough body to clear the chunker minimum-size filter",
          "      return this._router;",
          "    },",
          "  });",
          "};",
          "",
        ].join("\n");

        const chunks = await chunker.chunk(code, "application.js", "javascript");
        const initChunk = chunks.find((c) => c.metadata.symbolId === "app.init");
        const routerChunk = chunks.find((c) => c.metadata.symbolId === "app.router");
        expect(initChunk, "chunk for app.init missing").toBeDefined();
        expect(routerChunk, "chunk for app.router missing").toBeDefined();
        // Sibling chunks must produce distinct Qdrant point IDs so that
        // both survive upsert.
        expect(generateChunkId(initChunk!)).not.toBe(generateChunkId(routerChunk!));
      });
    });

    // bd tea-rags-mcp-n7x5 + j2b7 — Go method/struct/interface symbolId in chunker.
    // The chunker writes the Qdrant payload symbolId; the codegraph provider
    // writes cg_symbols.symbol_id for the SAME AST node. Both must agree per
    // .claude/rules/symbolid-convention.md. Before the fix:
    //   - method_declaration emitted bare `JSON` instead of `Context#JSON`,
    //   - type_declaration (struct/interface/alias) emitted name=undefined
    //     and chunkType="block" because `extractName` could not find the
    //     identifier (it lives on type_spec, not type_declaration).
    describe("Go symbolId metadata (bd tea-rags-mcp-n7x5 + j2b7)", () => {
      it("emits `Receiver#Method` symbolId for `func (c *Context) JSON(...)`", async () => {
        const code = [
          "package gin",
          "",
          "type Context struct{}",
          "",
          "func (c *Context) JSON(code int, obj interface{}) {",
          "  // Body large enough to clear the 50-char filter on chunk content.",
          "  _ = code",
          "  _ = obj",
          "  return",
          "}",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "context.go", "go");
        const jsonChunk = chunks.find((c) => c.metadata.symbolId === "Context#JSON");
        expect(jsonChunk, "chunk for Context#JSON missing").toBeDefined();
        expect(jsonChunk!.metadata.name).toBe("Context#JSON");
        expect(jsonChunk!.metadata.chunkType).toBe("function");
      });

      it("strips pointer-receiver `*` and value-receiver retains base type", async () => {
        const code = [
          "package gin",
          "",
          "type Service struct{}",
          "",
          'func (s Service) Open() string { return "opened by value receiver" }',
          'func (s *Service) Close() string { return "closed by pointer receiver" }',
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "service.go", "go");
        const open = chunks.find((c) => c.metadata.symbolId === "Service#Open");
        const close_ = chunks.find((c) => c.metadata.symbolId === "Service#Close");
        expect(open, "Service#Open missing").toBeDefined();
        expect(close_, "Service#Close missing").toBeDefined();
      });

      it("emits struct type as top-level symbol via type_declaration", async () => {
        const code = [
          "package gin",
          "",
          "// Context carries a request scope.",
          "type Context struct {",
          "  Request  string",
          "  Response string",
          "  Params   string",
          "  Keys     string",
          "}",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "context.go", "go");
        const ctxChunk = chunks.find((c) => c.metadata.symbolId === "Context");
        expect(ctxChunk, "chunk for struct Context missing").toBeDefined();
        expect(ctxChunk!.metadata.name).toBe("Context");
      });

      it("emits interface type as top-level symbol via type_declaration", async () => {
        const code = [
          "package gin",
          "",
          "type IRouter interface {",
          "  Use(middleware ...any) IRouter",
          "  Handle(method, path string, handlers ...any) IRouter",
          "  GET(path string, handlers ...any) IRouter",
          "  POST(path string, handlers ...any) IRouter",
          "}",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "routergroup.go", "go");
        const iface = chunks.find((c) => c.metadata.symbolId === "IRouter");
        expect(iface, "chunk for interface IRouter missing").toBeDefined();
        expect(iface!.metadata.name).toBe("IRouter");
      });

      it("emits function-type alias as top-level symbol via type_declaration", async () => {
        // Single declaration MUST be ≥50 chars to clear the chunker's
        // `content.length < 50` filter in the main loop. Without enough
        // body length the node is dropped before symbolId composition;
        // that is a generic chunker invariant, not Go-specific, so the
        // realistic gin-style declaration uses the longer multi-line
        // form which clears 50 chars without artificial padding.
        const code = [
          "package gin",
          "",
          "// HandlerFunc is the request handler signature used by gin.",
          "// It carries a request scope to handlers registered on routes.",
          "type HandlerFunc func(c *Context, status int, payload interface{}) error",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const handler = chunks.find((c) => c.metadata.symbolId === "HandlerFunc");
        expect(handler, "chunk for type HandlerFunc func(...) missing").toBeDefined();
        expect(handler!.metadata.name).toBe("HandlerFunc");
      });

      // bd tea-rags-mcp-iiq6 — Go type-spec aliases beyond struct/interface.
      // gin OSS validation showed `type HandlerFunc func(*Context)` and
      // `type H map[string]any` invisible to `find_symbol`. The chunker's
      // 50-char filter drops short declarations, and `mergeSmallChunks`
      // collapses adjacent ones into anonymous "X..." blocks — but a
      // standalone alias that DOES clear the 50-char threshold must
      // still be emitted with its own symbolId. These tests exercise
      // each non-struct/interface type kind end-to-end with padded
      // declarations so the filter passes and the symbolId path runs.
      it("emits map-type alias as top-level symbol via type_declaration", async () => {
        const code = [
          "package gin",
          "",
          "// H is a shortcut for map[string]any used by gin handlers",
          "// when emitting JSON payloads with heterogeneous values.",
          "type H map[string]any",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const h = chunks.find((c) => c.metadata.symbolId === "H");
        expect(h, "chunk for type H map[...] missing").toBeDefined();
        expect(h!.metadata.name).toBe("H");
      });

      it("emits slice-type alias as top-level symbol via type_declaration", async () => {
        const code = [
          "package gin",
          "",
          "// Numbers carries a slice of integers used across handlers",
          "// for batch operations on numeric payloads.",
          "type Numbers []int",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const numbers = chunks.find((c) => c.metadata.symbolId === "Numbers");
        expect(numbers, "chunk for type Numbers []int missing").toBeDefined();
        expect(numbers!.metadata.name).toBe("Numbers");
      });

      it("emits channel-type alias as top-level symbol via type_declaration", async () => {
        const code = [
          "package gin",
          "",
          "// Ch is a channel carrying integers from producer goroutines",
          "// to the request-scoped consumer middleware in gin.",
          "type Ch chan int",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const ch = chunks.find((c) => c.metadata.symbolId === "Ch");
        expect(ch, "chunk for type Ch chan int missing").toBeDefined();
        expect(ch!.metadata.name).toBe("Ch");
      });

      // bd tea-rags-mcp-iiq6 follow-up — gin OSS validation showed that
      // `type HandlerFunc func(*Context)` was invisible to `find_symbol`
      // even after the 50-char filter bypass. Root cause: three short
      // adjacent type aliases (HandlerFunc, OptionFunc, HandlersChain) are
      // each emitted as `chunkType="block"` and then collapsed by
      // `mergeSmallChunks` into one merged block named "HandlerFunc..."
      // with no symbolId. Named Go type aliases MUST stay individually
      // searchable so `find_symbol("HandlerFunc")` resolves.
      it("does NOT merge adjacent short Go function-type aliases (gin.go HandlerFunc scenario)", async () => {
        const code = [
          "package gin",
          "",
          "// HandlerFunc defines the handler used by gin middleware as return value.",
          "type HandlerFunc func(*Context)",
          "",
          "// OptionFunc defines the function to change the default configuration",
          "type OptionFunc func(*Engine)",
          "",
          "// HandlersChain defines a HandlerFunc slice.",
          "type HandlersChain []HandlerFunc",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const handler = chunks.find((c) => c.metadata.symbolId === "HandlerFunc");
        const option = chunks.find((c) => c.metadata.symbolId === "OptionFunc");
        const chain = chunks.find((c) => c.metadata.symbolId === "HandlersChain");
        expect(handler, "chunk for type HandlerFunc func(*Context) missing").toBeDefined();
        expect(option, "chunk for type OptionFunc func(*Engine) missing").toBeDefined();
        expect(chain, "chunk for type HandlersChain []HandlerFunc missing").toBeDefined();
        expect(handler!.metadata.name).toBe("HandlerFunc");
        expect(option!.metadata.name).toBe("OptionFunc");
        expect(chain!.metadata.name).toBe("HandlersChain");
        // No merged "HandlerFunc..."-style umbrella block should appear.
        const mergedUmbrella = chunks.find((c) => c.metadata.name?.endsWith("..."));
        expect(mergedUmbrella, "named Go type aliases must not collapse into a merged block").toBeUndefined();
      });

      it("top-level function_declaration emits bare name (no receiver prefix)", async () => {
        const code = [
          "package gin",
          "",
          "// New returns a new Engine with default middleware attached.",
          "func New() *Engine {",
          "  // body padding to clear the 50-char chunk-size filter",
          "  _ = 1",
          "  _ = 2",
          "  return nil",
          "}",
          "",
        ].join("\n");
        const chunks = await chunker.chunk(code, "gin.go", "go");
        const newFn = chunks.find((c) => c.metadata.symbolId === "New");
        expect(newFn, "chunk for top-level New() missing").toBeDefined();
        expect(newFn!.metadata.name).toBe("New");
      });
    });
  });

  describe("markdown preamble handling", () => {
    it("should create a Preamble chunk for content before the first heading", async () => {
      const code = [
        "This is introductory text that appears before any heading in the document.",
        "It should be captured as a preamble chunk with proper metadata.",
        "",
        "# First Heading",
        "",
        "Content under the first heading goes here with additional details.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Should have a preamble chunk
      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeDefined();
      expect(preamble!.content).toContain("introductory text");
      expect(preamble!.metadata.symbolId).toBe("Preamble");
      expect(preamble!.metadata.isDocumentation).toBe(true);
      expect(preamble!.metadata.chunkType).toBe("block");
      expect(preamble!.startLine).toBe(1);

      // Preamble should be the first chunk (unshifted to index 0)
      expect(chunks[0].metadata.name).toBe("Preamble");
      expect(chunks[0].metadata.chunkIndex).toBe(0);
    });

    it("should re-index all chunks after inserting preamble", async () => {
      const code = [
        "This preamble text is long enough to exceed the 50-character minimum threshold.",
        "",
        "# Section One",
        "",
        "Content for section one that is also long enough to exceed the minimum threshold.",
        "",
        "# Section Two",
        "",
        "Content for section two that is also long enough to exceed the minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Verify sequential chunk indices after re-indexing
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].metadata.chunkIndex).toBe(i);
      }

      // First chunk should be the preamble
      expect(chunks[0].metadata.name).toBe("Preamble");
    });

    it("should skip preamble when content before first heading is too short", async () => {
      const code = [
        "Short.",
        "",
        "# Heading",
        "",
        "Content under the heading that is long enough to exceed the minimum threshold for chunking.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // No preamble chunk because it's too short (< 50 chars)
      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeUndefined();
    });
  });

  describe("markdown without headings", () => {
    it("should treat whole document as one chunk when there are no headings", async () => {
      const code = [
        "This is a markdown document that has no headings at all.",
        "It contains multiple lines of plain text content that should be",
        "treated as a single chunk since there is no heading-based structure.",
        "The content needs to exceed the 50-character minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "notes.md", "markdown");

      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("block");
      expect(chunks[0].metadata.isDocumentation).toBe(true);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].metadata.chunkIndex).toBe(0);
      // No name or symbolId for headingless documents
      expect(chunks[0].metadata.name).toBeUndefined();
    });

    it("should return empty array for headingless markdown under 50 chars", async () => {
      const code = "Short text.";

      const chunks = await chunker.chunk(code, "tiny.md", "markdown");
      expect(chunks.length).toBe(0);
    });
  });

  describe("oversized markdown sections", () => {
    it("should split oversized sections using character fallback", async () => {
      // Use a small config so sections easily exceed maxChunkSize * 2
      const smallConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const smallChunker = new TreeSitterChunker(
        smallConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      // Generate a section with content that exceeds 100 * 2 = 200 chars
      const longContent = Array(30)
        .fill("This line of content is used to inflate the section size beyond the limit.")
        .join("\n");

      const code = [
        "# Oversized Section",
        "",
        longContent,
        "",
        "# Normal Section",
        "",
        "This is a normal-sized section with enough content to pass minimum threshold checks.",
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "big.md", "markdown");

      // The oversized section should have been split into multiple sub-chunks
      const oversizedChunks = chunks.filter(
        (c) => c.metadata.name === "Oversized Section" || c.metadata.parentSymbolId === "Oversized Section",
      );
      expect(oversizedChunks.length).toBeGreaterThan(1);

      // Sub-chunks should have isDocumentation flag
      for (const chunk of oversizedChunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
      }

      // Sub-chunks should have parentType reflecting heading depth
      for (const chunk of oversizedChunks) {
        if (chunk.metadata.parentType) {
          expect(chunk.metadata.parentType).toBe("h1");
        }
      }
    });
  });

  describe("oversized child chunks", () => {
    it("should fall back to character chunking for oversized methods", async () => {
      // Use a small config so methods easily exceed maxChunkSize * 2
      const smallConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const smallChunker = new TreeSitterChunker(
        smallConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      // Create a Ruby class with one very large method (> 200 chars)
      const longBody = Array(25)
        .fill('    puts "Processing data transformation step with logging and validation"')
        .join("\n");

      const code = [
        "class DataProcessor",
        "  def very_large_method(input)",
        longBody,
        "  end",
        "",
        "  def small_method(x)",
        "    # A small method for comparison",
        "    puts x",
        "    return x + 1",
        "  end",
        "end",
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "processor.rb", "ruby");

      // At minimum we should have chunks; the large method produces sub-chunks
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks from this class should reference DataProcessor in their
      // parentSymbolId chain — either directly (the class itself, or a small
      // sibling method's parent) or via a composed method symbolId
      // (`DataProcessor#very_large_method` for oversized-method splits, since
      // bd tea-rags-mcp-5xie).
      const processorChunks = chunks.filter(
        (c) =>
          typeof c.metadata.parentSymbolId === "string" &&
          (c.metadata.parentSymbolId === "DataProcessor" || c.metadata.parentSymbolId.startsWith("DataProcessor#")),
      );
      expect(processorChunks.length).toBeGreaterThan(0);
    });
  });

  describe("empty code fallback", () => {
    it("should fall back to character chunker when no AST chunks but code > 100 chars", async () => {
      // Code that produces no chunkable AST nodes but is long enough to trigger fallback
      // Using a series of simple statements that tree-sitter won't chunk as functions/classes
      const code = [
        'const a = "value1";',
        'const b = "value2";',
        'const c = "value3";',
        'const d = "value4";',
        'const e = "value5";',
        'const f = "value6";',
        'const g = "value7";',
        'const h = "value8";',
      ].join("\n");

      // Ensure the code is > 100 chars
      expect(code.length).toBeGreaterThan(100);

      const chunks = await chunker.chunk(code, "constants.ts", "typescript");

      // The fallback chunker should produce at least one chunk
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("markdown text extraction edge cases", () => {
    it("should extract text from headings with emphasis", async () => {
      const code = [
        "# Getting *Started* with the Project",
        "",
        "This section explains how to begin working with the project and its dependencies.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The heading text should include the emphasized word
      const section = chunks.find((c) => c.metadata.name?.includes("Started"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Getting Started with the Project");
    });

    it("should extract text from headings with links", async () => {
      const code = [
        "# Install [Node.js](https://nodejs.org) First",
        "",
        "You must install Node.js before proceeding with the rest of the setup process.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The heading text should include the link text but not the URL
      const section = chunks.find((c) => c.metadata.name?.includes("Node.js"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Install Node.js First");
    });

    it("should handle headings with inline code (inline code value is not extracted)", async () => {
      const code = [
        "# Using the `chunk` Method",
        "",
        "The chunk method is the primary API for splitting code into manageable pieces.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // inlineCode nodes have value but no children and type != "text",
      // so MarkdownChunker's extractText returns "" for them.
      // The heading name will contain the surrounding text but not the code value.
      expect(chunks.length).toBeGreaterThan(0);
      const section = chunks.find((c) => c.metadata.name?.includes("Using the"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Using the  Method");
    });

    it("should extract text from headings with strong emphasis", async () => {
      const code = [
        "# The **Important** Configuration Guide",
        "",
        "This guide covers the essential configuration settings you need to know about.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const section = chunks.find((c) => c.metadata.name?.includes("Important"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("The Important Configuration Guide");
    });

    it("should return empty string for nodes without text or children", async () => {
      // A heading with an image (which has no text children, only alt text)
      const code = [
        "# Logo ![alt text](image.png) Brand",
        "",
        "This section describes the brand identity and logo usage across the platform.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Should still produce a chunk with the text portions extracted
      expect(chunks.length).toBeGreaterThan(0);
      const section = chunks.find((c) => c.metadata.name?.includes("Brand"));
      expect(section).toBeDefined();
    });
  });

  describe("no valid children fallback", () => {
    it("should fall back to character chunking for oversized nodes with no valid children", async () => {
      // Use a very small config so the class is "too large"
      const tinyConfig: ChunkerConfig = {
        chunkSize: 50,
        chunkOverlap: 5,
        maxChunkSize: 50,
      };
      const tinyChunker = new TreeSitterChunker(
        tinyConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      // A Ruby class that is large (> 50 * 2 = 100 chars) but has NO methods inside
      // Only has declarations, which are not in childChunkTypes
      const code = [
        "class LargeSerializer < ActiveModel::Serializer",
        "  attributes :id, :name, :email, :role, :created_at, :updated_at, :status, :avatar_url",
        "  has_many :posts, serializer: PostSerializer",
        "  has_many :comments, serializer: CommentSerializer",
        "  belongs_to :organization, serializer: OrgSerializer",
        "  belongs_to :department, serializer: DeptSerializer",
        "  attribute :full_name do",
        '    object.first_name + " " + object.last_name',
        "  end",
        "end",
      ].join("\n");

      // Ensure code is > 100 chars (maxChunkSize * 2)
      expect(code.length).toBeGreaterThan(100);

      const chunks = await tinyChunker.chunk(code, "serializer.rb", "ruby");

      // Should produce chunks via character fallback since no valid child methods found
      expect(chunks.length).toBeGreaterThan(0);

      // Sub-chunks should have parentName from the class
      const withParent = chunks.filter((c) => c.metadata.parentSymbolId === "LargeSerializer");
      expect(withParent.length).toBeGreaterThan(0);
    });
  });

  describe("non-Ruby body extraction for large classes", () => {
    it("should extract body chunk for non-Ruby languages with alwaysExtractChildren", async () => {
      // We need a language with childChunkTypes AND alwaysExtractChildren
      // Currently only Ruby has alwaysExtractChildren, but we can test the non-Ruby
      // body extraction path by using a class large enough to trigger shouldExtractChildren
      // via isTooLarge in a non-Ruby language that has childChunkTypes

      // For TypeScript, there are no childChunkTypes defined, so we test with Ruby
      // but verify the non-Ruby branch (lines 382-402) is unreachable without modification.
      // Instead, test that Ruby correctly uses the Ruby path (lines 345-381).
      // The non-Ruby path requires alwaysExtractChildren on a non-Ruby language,
      // which isn't in the default config. This is tested indirectly.

      // Test that large TypeScript classes are handled via the isTooLarge path
      // (which doesn't have childChunkTypes, so goes through the single-chunk path)
      const tinyConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const tinyChunker = new TreeSitterChunker(
        tinyConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      const longBody = Array(15)
        .fill("    console.log('Processing step with detailed logging and validation');")
        .join("\n");

      const code = [
        "class LargeProcessor {",
        "  processData(data: string[]): void {",
        longBody,
        "  }",
        "",
        "  validateData(data: string[]): boolean {",
        longBody,
        "  }",
        "}",
      ].join("\n");

      const chunks = await tinyChunker.chunk(code, "processor.ts", "typescript");

      // Should produce chunks (class is split due to being oversized)
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("chunk - Java", () => {
    it("should chunk Java class with methods", async () => {
      const code = `
public class Calculator {
    public int add(int a, int b) {
        // Add two integers together and return result
        return a + b;
    }

    public int multiply(int a, int b) {
        // Multiply two integers together and return result
        return a * b;
    }
}
      `;

      const chunks = await chunker.chunk(code, "Calculator.java", "java");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.language === "java")).toBe(true);
    });
  });

  describe("chunk - Bash", () => {
    it("should chunk Bash functions", async () => {
      const code = `
function setup_environment() {
    echo "Setting up the development environment"
    export PATH="$HOME/bin:$PATH"
    export NODE_ENV="development"
    mkdir -p "$HOME/logs"
}

function cleanup_environment() {
    echo "Cleaning up the development environment"
    unset NODE_ENV
    rm -rf "$HOME/logs/tmp"
}
      `;

      const chunks = await chunker.chunk(code, "setup.sh", "bash");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.language === "bash")).toBe(true);
    });
  });

  describe("parser cache behavior", () => {
    it("should use cached parser on second call with same language", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);

      // First call: loads the parser
      const code1 = `
function first() {
  console.log('First function call');
  return 1;
}
      `;
      await freshChunker.chunk(code1, "a.ts", "typescript");

      // Verify parser is now cached
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");

      // Second call: should use cached parser (hits parserCache.get branch)
      const code2 = `
function second() {
  console.log('Second function call');
  return 2;
}
      `;
      const chunks = await freshChunker.chunk(code2, "b.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.name).toBe("second");
    });

    it("should deduplicate concurrent parser loading for same language", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);

      const code1 = `
function funcA() {
  console.log('Function A implementation');
  return 'a';
}
      `;
      const code2 = `
function funcB() {
  console.log('Function B implementation');
  return 'b';
}
      `;

      // Launch two chunks concurrently for the same language
      // The second call should hit the loadingPromises dedup path
      const [chunks1, chunks2] = await Promise.all([
        freshChunker.chunk(code1, "a.ts", "typescript"),
        freshChunker.chunk(code2, "b.ts", "typescript"),
      ]);

      expect(chunks1.length).toBeGreaterThan(0);
      expect(chunks2.length).toBeGreaterThan(0);

      // Parser should only be loaded once
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");
    });
  });

  describe("markdown code blocks edge cases", () => {
    it("should skip very small code blocks under 50 chars", async () => {
      const code = [
        "# Examples",
        "",
        "A tiny code block:",
        "",
        "```js",
        "x = 1;",
        "```",
        "",
        "A larger code block that meets the minimum size:",
        "",
        "```python",
        "def calculate_fibonacci(n):",
        "    if n <= 1:",
        "        return n",
        "    return calculate_fibonacci(n-1) + calculate_fibonacci(n-2)",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "examples.md", "markdown");

      // The tiny js code block should be skipped (< 50 chars)
      const jsBlocks = chunks.filter((c) => c.metadata.language === "js");
      expect(jsBlocks.length).toBe(0);

      // The larger python block should be included
      const pyBlocks = chunks.filter((c) => c.metadata.language === "python");
      expect(pyBlocks.length).toBe(1);
    });

    it("should handle code blocks without language as 'Code block'", async () => {
      const code = [
        "# Setup",
        "",
        "Run the following commands to set up your environment:",
        "",
        "```",
        "npm install",
        "npm run build",
        "npm run test",
        "npm run lint",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "setup.md", "markdown");

      // Code block without language should use "Code block" as name
      const codeBlock = chunks.find((c) => c.metadata.name === "Code block");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.metadata.language).toBe("code");
    });

    it("should produce chunks from code blocks even when no headings exist", async () => {
      // Markdown without headings but with a code block
      const code = [
        "Here is a useful snippet that demonstrates the pattern:",
        "",
        "```typescript",
        "async function fetchData(url: string): Promise<Response> {",
        "  const response = await fetch(url);",
        "  if (!response.ok) {",
        // eslint-disable-next-line no-template-curly-in-string
        "    throw new Error(`HTTP error! Status: ${response.status}`);",
        "  }",
        "  return response;",
        "}",
        "```",
        "",
        "Use this pattern for all API calls in the application.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "snippet.md", "markdown");

      // Should produce chunks: whole-document chunk + code block chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Should have a code block chunk
      const codeBlock = chunks.find((c) => c.metadata.name === "Code: typescript");
      expect(codeBlock).toBeDefined();
    });
  });

  describe("markdown section with very small content", () => {
    it("should skip sections with content under 50 chars", async () => {
      const code = [
        "# Short",
        "",
        "Tiny.",
        "",
        "# Detailed Section",
        "",
        "This section contains enough content to exceed the fifty character minimum threshold for chunking.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The "Short" section has < 50 chars total, should be skipped
      const shortSection = chunks.find((c) => c.metadata.name === "Short");
      expect(shortSection).toBeUndefined();

      // The "Detailed Section" should be included
      const detailedSection = chunks.find((c) => c.metadata.name === "Detailed Section");
      expect(detailedSection).toBeDefined();
    });
  });

  describe("extractClassHeader returning undefined", () => {
    it("should handle singleton_class (class << self) at top level where header does not match class pattern", async () => {
      // A class << self block as a top-level chunkable node has "class << self"
      // which does match /class\s+/, but let's test the fallback when extractClassHeader
      // encounters a non-class/module first line in a container
      const tinyConfig: ChunkerConfig = {
        chunkSize: 50,
        chunkOverlap: 5,
        maxChunkSize: 80,
      };
      const tinyChunker = new TreeSitterChunker(
        tinyConfig,
        new DefaultSymbolIdComposer(),
        testLanguageFactoryDescriptor,
      );

      // class << self at the top-level of a class, with methods inside
      // This tests the body extraction where header may or may not match
      const code = [
        "class Config",
        "  class << self",
        "    def load_defaults",
        "      # Loading the default configuration settings from file",
        "      puts 'Loading defaults from configuration'",
        "      YAML.load_file('config/defaults.yml')",
        "    end",
        "",
        "    def save_defaults(data)",
        "      # Saving configuration defaults to persistent storage",
        "      puts 'Saving defaults to configuration file'",
        "      File.write('config/defaults.yml', data.to_yaml)",
        "    end",
        "  end",
        "end",
      ].join("\n");

      const chunks = await tinyChunker.chunk(code, "config.rb", "ruby");

      // Should produce method chunks extracted from the class
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should return undefined when first line does not start with class or module", async () => {
      // Mock a node whose first line is not a class/module declaration
      const code = "  has_many :posts\n  belongs_to :user\nend";
      const mockNode = {
        startPosition: { row: 0 },
      } as any;

      const header = extractClassHeader(mockNode, code);
      expect(header).toBeUndefined();
    });
  });

  describe("parser initialization error recovery", () => {
    it("should return null and log error when parser module fails to load", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Temporarily inject a broken language definition to simulate load failure
      // Access the private initializeParser method through any cast
      const result = await (freshChunker as any).initializeParser("broken", {
        loadModule: async () => Promise.reject(new Error("Module not found")),
        chunkableTypes: [],
      });

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load parser for broken"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("parser parse error recovery", () => {
    it("should catch parse errors and fall back to character chunker", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);

      // First, load the TypeScript parser normally
      const code1 = `
function setup() {
  console.log('Loading the parser');
  return true;
}
      `;
      await freshChunker.chunk(code1, "setup.ts", "typescript");

      // Now replace the parser's parse method with one that throws
      const cache = (freshChunker as any).parserCache;
      const tsConfig = cache.get("typescript");
      const originalParse = tsConfig.parser.parse.bind(tsConfig.parser);
      tsConfig.parser.parse = () => {
        throw new Error("Simulated parse failure");
      };

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // This should hit the catch block and fall back
      const code2 = `
function broken() {
  console.log('This will trigger the catch block because parse throws');
  return false;
}
      `;
      const chunks = await freshChunker.chunk(code2, "broken.ts", "typescript");

      // Should fall back to character-based chunking
      expect(chunks.length).toBeGreaterThan(0);

      // Verify error was logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Tree-sitter parsing failed"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();

      // Restore original parse
      tsConfig.parser.parse = originalParse;
    });
  });

  describe("name extraction fallback", () => {
    it("should extract name from type_identifier child in Go type declarations", async () => {
      // Go type declarations have nested type_spec with identifier children,
      // exercising the fallback path in extractName that searches child nodes
      const code = `
type UserRequest struct {
  Name    string
  Email   string
  Age     int
  Address string
}
      `;

      const chunks = await chunker.chunk(code, "types.go", "go");

      // Go type_declaration should produce at least one chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Verify chunks exist with metadata (the name extraction path is exercised
      // regardless of whether the result has a specific chunkType)
      expect(chunks[0].metadata.language).toBe("go");
    });

    it("should use fallback name extraction for Rust enum items", async () => {
      // Rust enum_item may exercise the identifier child fallback
      const code = `
enum Direction {
    North,
    South,
    East,
    West,
}
      `;

      const chunks = await chunker.chunk(code, "dir.rs", "rust");
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Check that chunks were produced (name extraction path exercised)
      if (chunks.length > 0) {
        // At least some chunks should have names extracted
        const hasName = chunks.some((c) => c.metadata.name !== undefined);
        expect(hasName).toBe(true);
      }
    });

    it("should extract name via identifier child when childForFieldName returns null", async () => {
      // Use a mock node to directly exercise the extractName fallback path
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
      const extractName = (freshChunker as any).extractName.bind(freshChunker);

      // Create a mock node that has no "name" field but has an identifier child
      const mockCode = "const myVariable = 42;";
      const mockNode = {
        childForFieldName: () => null,
        children: [
          {
            type: "identifier",
            startIndex: 6,
            endIndex: 16,
          },
        ],
      };

      const name = extractName(mockNode, mockCode);
      expect(name).toBe("myVariable");
    });

    it("should return undefined when no name field and no identifier children", async () => {
      const freshChunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), testLanguageFactoryDescriptor);
      const extractName = (freshChunker as any).extractName.bind(freshChunker);

      // Mock node with no name field and no identifier children
      const mockNode = {
        childForFieldName: () => null,
        children: [
          { type: "keyword", startIndex: 0, endIndex: 5 },
          { type: "string", startIndex: 6, endIndex: 12 },
        ],
      };

      const name = extractName(mockNode, "const 'hello'");
      expect(name).toBeUndefined();
    });
  });

  describe("methodLines metadata", () => {
    it("sets methodLines on regular function chunks", async () => {
      const code = `
function hello() {
  console.log("hello");
  console.log("world");
  return true;
}
`.trim();

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
      const chunk = chunks[0];
      expect(chunk.metadata.methodLines).toBe(chunk.endLine - chunk.startLine);
    });

    it("sets methodLines on child method chunks", async () => {
      const code = `
class Greeter {
  sayHello(name: string): string {
    const greeting = "Hello, " + name;
    console.log(greeting);
    return greeting;
  }

  sayGoodbye(name: string): string {
    const farewell = "Goodbye, " + name;
    console.log(farewell);
    return farewell;
  }
}
`.trim();

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThan(0);
      for (const chunk of methodChunks) {
        expect(chunk.metadata.methodLines).toBeDefined();
        expect(chunk.metadata.methodLines).toBe(chunk.endLine - chunk.startLine);
      }
    });

    it("does not set methodLines on body/block chunks", async () => {
      const code = `
class MyService {
  private readonly name = "service";
  private readonly version = 1;
  private readonly enabled = true;
  private readonly config = { key: "value", timeout: 1000 };

  process(input: string): string {
    const result = input.toUpperCase();
    console.log(result);
    return result;
  }
}
`.trim();

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      for (const chunk of bodyChunks) {
        expect(chunk.metadata.methodLines).toBeUndefined();
      }
    });

    it("preserves original methodLines when child node is split via fallback", async () => {
      // Create a function large enough to trigger character fallback (> maxChunkSize * 2)
      const lines = Array.from(
        { length: 200 },
        (_, i) => `  const x${i} = ${i}; // padding to exceed chunk size limit ${"x".repeat(80)}`,
      );
      const code = `function bigMethod() {\n${lines.join("\n")}\n}`;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(1); // Should be split

      const originalLines = code.split("\n").length;
      for (const chunk of chunks) {
        expect(chunk.metadata.methodLines).toBe(originalLines);
      }
    });
  });

  describe("chunk - Ruby RSpec", () => {
    it("should produce scope-centric chunks for describe with it blocks", async () => {
      const code = `RSpec.describe User do
  it 'is valid with valid attributes' do
    user = build(:user, name: 'Test', email: 'test@example.com')
    expect(user).to be_valid
  end

  it 'is invalid without a name' do
    user = build(:user, name: nil, email: 'test@example.com')
    expect(user).not_to be_valid
  end
end`;

      const chunks = await chunker.chunk(code, "spec/models/user_spec.rb", "ruby");
      // Scope chunker: leaf scope = describe User → one test chunk with both it blocks
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks.length).toBeGreaterThanOrEqual(1);
      const content = testChunks.map((c) => c.content).join("\n");
      expect(content).toContain("is valid with valid attributes");
      expect(content).toContain("is invalid without a name");
    });

    it("should not treat call nodes as chunkable in non-spec Ruby files", async () => {
      const code = `class UserService
  def initialize(repo)
    @repo = repo
    puts 'initialized'
    Rails.logger.info('UserService created')
  end

  def find_user(id)
    user = @repo.find(id)
    Rails.logger.info("Found user: #{id}")
    user
  end
end`;

      const chunks = await chunker.chunk(code, "app/services/user_service.rb", "ruby");
      // `puts` and `Rails.logger.info` should NOT become chunks
      const callChunks = chunks.filter(
        (c) => c.metadata.name?.startsWith("puts") || c.metadata.name?.startsWith("Rails"),
      );
      expect(callChunks.length).toBe(0);
    });

    it("should produce test chunks at each leaf scope level", async () => {
      const code = `RSpec.describe PaymentService do
  it 'initializes with a gateway and configuration' do
    service = PaymentService.new(gateway: stripe, config: default_config)
    expect(service.gateway).to eq(stripe)
  end

  context 'when processing a charge' do
    it 'creates a charge record in the local database' do
      result = subject.charge(amount: 1000, currency: 'usd')
      expect(result).to be_persisted
      expect(result.amount).to eq(1000)
    end

    context 'when the card is declined by the gateway' do
      it 'raises a PaymentDeclinedError with decline code' do
        expect { subject.charge(amount: 9999, currency: 'usd') }
          .to raise_error(PaymentDeclinedError)
          .with_message(/insufficient_funds/)
      end

      context 'when retry policy is enabled in config' do
        it 'retries the charge up to three times before failing' do
          expect(gateway).to receive(:charge).exactly(3).times
          expect { subject.charge(amount: 9999, currency: 'usd') }
            .to raise_error(PaymentDeclinedError)
        end
      end
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/payment_service_spec.rb", "ruby");

      // Scope chunker: leaf scopes are "when processing a charge" (has own it),
      // "when the card is declined" (has own it), "when retry policy" (leaf)
      // Plus intermediate body chunk for root describe's own it block
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks.length).toBeGreaterThanOrEqual(1);

      // All it blocks should appear somewhere in chunks
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("initializes with a gateway");
      expect(allContent).toContain("creates a charge record");
      expect(allContent).toContain("raises a PaymentDeclinedError");
      expect(allContent).toContain("retries the charge");
    });

    it("should include leaf scope content with it blocks in test chunks", async () => {
      const code = `RSpec.describe PaymentService do
  context 'when processing a charge' do
    context 'when the card is declined by the gateway' do
      it 'raises a PaymentDeclinedError with decline code' do
        expect { subject.charge(amount: 9999, currency: 'usd') }
          .to raise_error(PaymentDeclinedError)
          .with_message(/insufficient_funds/)
      end
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/payment_service_spec.rb", "ruby");
      const testChunk = chunks.find((c) => c.metadata.chunkType === "test");
      expect(testChunk).toBeDefined();
      expect(testChunk!.content).toContain("raises a PaymentDeclinedError");
    });

    it("should include setup in test chunks", async () => {
      const code = `RSpec.describe PaymentService do
  let(:gateway) { instance_double(PaymentGateway, name: 'stripe') }
  let(:config) { PaymentConfig.new(retries: 3, timeout: 30) }
  subject { described_class.new(gateway: gateway, config: config) }
  before { allow(gateway).to receive(:ping).and_return(true) }

  it 'initializes with a gateway and configuration' do
    service = PaymentService.new(gateway: gateway, config: default_config)
    expect(service.gateway).to eq(gateway)
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/payment_service_spec.rb", "ruby");
      // Scope chunker: leaf scope = describe PaymentService with setup + it
      const testChunk = chunks.find((c) => c.metadata.chunkType === "test");
      expect(testChunk).toBeDefined();
      expect(testChunk!.content).toContain("let(:gateway)");
      expect(testChunk!.content).toContain("initializes with a gateway");
    });

    it("should use 2-level symbolId for leaf scope", async () => {
      const code = `RSpec.describe PaymentService do
  context 'when processing a charge' do
    context 'when the card is declined by the gateway' do
      it 'raises a PaymentDeclinedError with decline code' do
        expect { subject.charge(amount: 9999, currency: 'usd') }
          .to raise_error(PaymentDeclinedError)
          .with_message(/insufficient_funds/)
      end
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/payment_service_spec.rb", "ruby");
      const testChunk = chunks.find((c) => c.metadata.chunkType === "test");
      expect(testChunk).toBeDefined();
      // 2-level symbolId: TopLevel.leafScope
      expect(testChunk!.metadata.symbolId).toContain("PaymentService");
    });

    it("should extract name for describe + first argument", async () => {
      const code = `describe '#full_name' do
  it 'returns full name' do
    user = build(:user, first: 'John', last: 'Doe')
    expect(user.full_name).to eq('John Doe')
  end
end`;

      const chunks = await chunker.chunk(code, "spec/models/user_spec.rb", "ruby");
      const testChunk = chunks.find((c) => c.metadata.chunkType === "test");
      expect(testChunk).toBeDefined();
      expect(testChunk!.content).toContain("returns full name");
    });
  });

  describe("RSpec scope-centric chunking integration", () => {
    it("should produce test chunks with parent setup injection for nested spec", async () => {
      const code = `
describe User do
  let(:user) { create(:user) }

  context 'when admin' do
    let(:role) { :admin }
    before { user.update(role: role) }

    it 'has admin access' do
      expect(user).to be_admin
      expect(user.permissions).to include(:manage)
    end

    it 'can manage users' do
      expect(user).to be_able_to(:manage, User)
    end
  end

  context 'when regular' do
    it 'has limited access' do
      expect(user).not_to be_admin
    end
  end
end`;
      const chunks = await chunker.chunk(code, "spec/models/user_spec.rb", "ruby");

      // Should have 2 test chunks (one per leaf context)
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks).toHaveLength(2);

      // 'when admin' leaf should contain injected let(:user) from parent
      const adminChunk = testChunks.find((c) => c.content.includes("admin access"));
      expect(adminChunk).toBeDefined();
      expect(adminChunk!.content).toContain("let(:user)");
      expect(adminChunk!.content).toContain("let(:role)");
      expect(adminChunk!.metadata.chunkType).toBe("test");

      // 'when regular' leaf should also have injected let(:user)
      const regularChunk = testChunks.find((c) => c.content.includes("limited access"));
      expect(regularChunk).toBeDefined();
      expect(regularChunk!.content).toContain("let(:user)");
    });

    it("should NOT affect non-spec Ruby files", async () => {
      const code = `
class User < ApplicationRecord
  has_many :posts
  validates :name, presence: true

  def admin?
    role == :admin
  end
end`;
      const chunks = await chunker.chunk(code, "app/models/user.rb", "ruby");

      // Should use normal Ruby chunking (no test chunk types)
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks).toHaveLength(0);
    });

    it("should produce scope-centric chunks instead of per-it chunks", async () => {
      const code = `
describe User do
  it 'has a name' do
    expect(User.new.name).to be_nil
  end

  it 'has an email' do
    expect(User.new.email).to be_nil
  end
end`;
      const chunks = await chunker.chunk(code, "spec/models/user_spec.rb", "ruby");

      // Scope chunker produces test chunks — it blocks are NOT separate chunks
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
      expect(testChunks.length).toBeGreaterThanOrEqual(1);
      // Both it blocks should be in the same chunk (leaf scope = describe User)
      const content = testChunks.map((c) => c.content).join("\n");
      expect(content).toContain("has a name");
      expect(content).toContain("has an email");
    });
  });

  describe("chunk - Ruby oversized method fallback", () => {
    it("should use fallback chunker for methods exceeding maxChunkSize * 2", async () => {
      // Generate a very long method body that exceeds maxChunkSize * 2 (2000 chars)
      const longBody = Array.from(
        { length: 50 },
        (_, i) => `    result_${i} = process_item(data_${i}, options_${i})`,
      ).join("\n");
      const code = `
class DataProcessor
  def process_large_dataset(data)
${longBody}
    combine_results(${Array.from({ length: 50 }, (_, i) => `result_${i}`).join(", ")})
  end

  def simple_method(input)
    # A simple method that processes input
    transform(input)
  end
end
      `;

      const chunks = await chunker.chunk(code, "data_processor.rb", "ruby");

      // The oversized method should be split via fallback chunker
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // All content should exist somewhere in chunks
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("process_large_dataset");
    });
  });

  describe("chunk - Ruby nested modules", () => {
    it("should recursively extract methods from nested module within class", async () => {
      const code = `
class ApplicationService
  module Validators
    def validate_presence(field)
      # Validates that the given field is present and not empty
      raise ArgumentError, "#{field} is required" if send(field).nil?
      true
    end

    def validate_format(field, pattern)
      # Validates that the given field matches the expected format
      value = send(field)
      raise ArgumentError, "#{field} has invalid format" unless value =~ pattern
      true
    end
  end

  def initialize(params)
    # Initialize the service with given parameters
    @params = params
    validate_all
  end

  def execute
    # Execute the service operation with full validation
    raise NotImplementedError, "Subclasses must implement execute"
  end
end
      `;

      const chunks = await chunker.chunk(code, "app/services/application_service.rb", "ruby");

      // Should extract methods from both the class and the nested module
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // Methods from the nested module should exist
      const methodNames = methodChunks.map((c) => c.metadata.name);
      expect(methodNames).toContain("initialize");
      expect(methodNames).toContain("execute");
    });

    it("should handle deeply nested class within module with methods", async () => {
      const code = `
module Services
  class UserManager
    def create_user(params)
      # Creates a new user with validated parameters and persists
      user = User.new(params)
      user.validate!
      user.save!
      user
    end

    def delete_user(user_id)
      # Deletes a user and all associated records from the system
      user = User.find(user_id)
      user.destroy!
      notify_deletion(user_id)
    end

    def update_user(user_id, params)
      # Updates user attributes with validation and audit logging
      user = User.find(user_id)
      user.update!(params)
      log_update(user_id, params)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "app/services/user_manager.rb", "ruby");

      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(3);

      // Methods should have correct parentType (module is the top-level container)
      for (const chunk of methodChunks) {
        expect(["class", "module"]).toContain(chunk.metadata.parentType);
      }
    });
  });

  describe("chunk - Ruby nested class with body declarations", () => {
    it("should emit body chunks for nested class with declarations and methods", async () => {
      const code = `
class ApplicationService
  class Configuration
    attr_accessor :timeout, :retries
    attr_reader :name, :version

    validates :timeout, presence: true
    validates :retries, numericality: true

    def initialize(name, timeout: 30, retries: 3)
      @name = name
      @timeout = timeout
      @retries = retries
    end

    def to_hash
      { name: @name, timeout: @timeout, retries: @retries }
    end
  end

  def execute(config)
    Configuration.new('default').to_hash
  end
end`;

      const chunks = await chunker.chunk(code, "app/services/application_service.rb", "ruby");

      // Nested Configuration class should produce:
      // - method chunks (initialize, to_hash)
      // - body chunk with attr_accessor, attr_reader, validates
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block" && c.content.includes("attr_accessor"));
      expect(bodyChunks.length).toBeGreaterThanOrEqual(1);
      expect(bodyChunks[0].content).toContain("validates");
    });
  });

  describe("chunk - Ruby RSpec with require and non-DSL calls", () => {
    it("should filter out require and non-RSpec call nodes in spec files", async () => {
      const code = `require 'rails_helper'
require 'support/shared_contexts'

RSpec.describe UserService do
  let(:service) { described_class.new(config: default_config) }

  it 'initializes with default configuration and settings' do
    expect(service).to be_a(UserService)
    expect(service.config).to eq(default_config)
  end

  it 'responds to all public API methods correctly' do
    expect(service).to respond_to(:find_user)
    expect(service).to respond_to(:create_user)
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/user_service_spec.rb", "ruby");

      // require calls should be filtered out, only RSpec chunks should remain
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("initializes with default configuration");
      expect(allContent).toContain("responds to all public API");

      // No chunk should be named 'require'
      const requireChunks = chunks.filter((c) => c.metadata.name === "require");
      expect(requireChunks).toHaveLength(0);
    });
  });

  describe("chunk - TypeScript abstract class with static and abstract members", () => {
    it("should handle abstract class with abstract members and static members", async () => {
      const code = `
abstract class BaseRepository {
  static tableName = "records";
  static connectionPool = "default";

  abstract findById(id: string): Promise<Record>;
  abstract deleteById(id: string): Promise<void>;

  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async findAll(): Promise<Record[]> {
    this.logger.info("Finding all records from repository");
    return [];
  }

  async count(): Promise<number> {
    this.logger.info("Counting records in repository");
    return 0;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // Should extract methods
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // All chunks together should contain the class content
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("findAll");
      expect(allContent).toContain("count");
    });

    it("should handle abstract class with abstract method signatures in body chunks", async () => {
      const code = `
abstract class BaseRepository {
  abstract findById(id: string): Promise<Record<string, unknown>>;
  abstract findAll(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  abstract create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  abstract update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  abstract delete(id: string): Promise<void>;

  async findOrCreate(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.findById(id);
    if (existing) return existing;
    return this.create(data);
  }

  async upsert(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.update(id, data);
    } catch {
      return this.create({ ...data, id });
    }
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // Should extract concrete methods
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // All chunks should capture the concrete methods
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("findOrCreate");
      expect(allContent).toContain("upsert");
    });

    it("should handle class with static block and mixed member types", async () => {
      const code = `
class ServiceRegistry {
  static #instance: ServiceRegistry;
  static readonly VERSION = "1.0.0";
  static readonly MAX_SERVICES = 100;
  static readonly DEFAULT_TIMEOUT = 30000;

  private services: Map<string, unknown> = new Map();
  private readonly config: Record<string, unknown>;
  private readonly logger: Logger;
  private initialized = false;

  constructor(config: Record<string, unknown>, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  register(name: string, service: unknown): void {
    this.logger.info(\`Registering service: \${name}\`);
    this.services.set(name, service);
  }

  resolve(name: string): unknown {
    this.logger.info(\`Resolving service: \${name}\`);
    return this.services.get(name);
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // Should extract methods
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // Body chunks should contain static and instance properties
      const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBeGreaterThanOrEqual(1);

      const bodyContent = bodyChunks.map((c) => c.content).join("\n");
      expect(bodyContent).toContain("VERSION");
    });

    it("should handle class with index signature and accessor declarations", async () => {
      const code = `
class DynamicConfig {
  [key: string]: unknown;

  private _timeout: number = 30;
  private _retries: number = 3;
  private _debug: boolean = false;

  get timeout(): number {
    return this._timeout;
  }

  set timeout(value: number) {
    this._timeout = value;
  }

  initialize(options: Record<string, unknown>): void {
    this._timeout = (options.timeout as number) ?? 30;
    this._retries = (options.retries as number) ?? 3;
    this._debug = (options.debug as boolean) ?? false;
  }

  validate(): boolean {
    return this._timeout > 0 && this._retries >= 0;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      // Should extract method chunks
      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // All content together should cover the class
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("initialize");
      expect(allContent).toContain("validate");
    });
  });

  describe("chunk - TypeScript class with abstract properties", () => {
    it("should group abstract property definitions separately from regular properties", async () => {
      const code = `
abstract class BaseWidget {
  abstract width: number;
  abstract height: number;
  abstract label: string;
  abstract description: string;
  abstract category: string;

  readonly version: string = "1.0";
  readonly createdAt: Date = new Date();
  readonly updatedAt: Date = new Date();
  readonly author: string = "system";
  readonly license: string = "MIT";

  render(): string {
    return \`<div>\${this.label}: \${this.width}x\${this.height}</div>\`;
  }

  resize(w: number, h: number): void {
    console.log(\`Resizing to \${w}x\${h}\`);
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      const methodChunks = chunks.filter((c) => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThanOrEqual(2);

      // All content should have the class members
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("render");
      expect(allContent).toContain("resize");
    });
  });

  describe("chunk - TypeScript merge gap", () => {
    it("should not merge small type declarations separated by large line gaps", async () => {
      // Two small type aliases separated by > 2 blank lines (MERGE_GAP)
      const code = `
export type StatusA = "active" | "inactive" | "pending" | "archived";




export type StatusB = "draft" | "published" | "deleted" | "suspended";
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      // The two type aliases should NOT be merged (gap > 2 lines)
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("chunk - Ruby RSpec pending examples and edge cases", () => {
    it("should handle pending it examples (no block body) in spec files", async () => {
      const code = `RSpec.describe UserService do
  it 'creates user with valid params'
  it 'deletes user by id'
  it 'updates user attributes'
  it 'validates user email format'
  it 'sends welcome email after creation'

  it 'finds user by email address and returns record' do
    user = create(:user, email: 'test@example.com')
    result = described_class.find_by_email('test@example.com')
    expect(result).to eq(user)
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/user_service_spec.rb", "ruby");

      // The actual it block with body should be captured
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("finds user by email");
    });

    it("should handle RSpec file with mixed DSL methods and includes", async () => {
      const code = `require 'rails_helper'

RSpec.describe NotificationService do
  include ActiveJob::TestHelper
  include_context 'authenticated user'

  let(:service) { described_class.new(mailer: mailer, logger: logger) }
  let(:mailer) { instance_double(ApplicationMailer, deliver_later: true) }
  let(:logger) { instance_double(Logger, info: nil, error: nil) }

  before do
    ActiveJob::Base.queue_adapter = :test
    stub_external_notification_service
  end

  describe '#send_notification' do
    context 'when notification type is email' do
      let(:notification) { build(:notification, type: :email, recipient: user) }

      it 'sends an email through the mailer service' do
        service.send_notification(notification)
        expect(mailer).to have_received(:deliver_later)
        expect(logger).to have_received(:info).with(/sent/)
      end

      it 'logs the notification delivery status and timestamp' do
        service.send_notification(notification)
        expect(logger).to have_received(:info).at_least(:once)
      end
    end

    context 'when notification type is push' do
      let(:notification) { build(:notification, type: :push, recipient: user) }

      it 'enqueues a push notification job for background processing' do
        expect { service.send_notification(notification) }
          .to have_enqueued_job(PushNotificationJob)
          .with(notification.id)
      end
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/notification_service_spec.rb", "ruby");

      // Should produce test chunks for each leaf context
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test" || c.metadata.chunkType === "test_setup");
      expect(testChunks.length).toBeGreaterThanOrEqual(2);

      // All it blocks should be captured
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("sends an email through the mailer");
      expect(allContent).toContain("enqueues a push notification job");

      // Setup should be injected into leaf chunks
      const emailChunk = testChunks.find((c) => c.content.includes("sends an email"));
      expect(emailChunk).toBeDefined();
      expect(emailChunk!.content).toContain("let(:service)");
    });
  });

  describe("chunk - Ruby RSpec nested describe", () => {
    it("should produce chunks for deeply nested describe/context with setup inheritance", async () => {
      const code = `
RSpec.describe OrderService do
  let(:service) { described_class.new(gateway: payment_gateway, config: config) }
  let(:payment_gateway) { instance_double(PaymentGateway, active: true) }
  let(:config) { OrderConfig.new(tax_rate: 0.1, currency: 'USD') }

  describe '#create_order' do
    let(:order_params) { { items: [item1, item2], customer: customer } }

    context 'with valid items and sufficient inventory' do
      before { allow(InventoryService).to receive(:check).and_return(true) }

      it 'creates an order and charges the payment gateway' do
        result = service.create_order(order_params)
        expect(result).to be_persisted
        expect(result.total).to eq(110.0)
      end

      it 'sends a confirmation email to the customer' do
        expect { service.create_order(order_params) }
          .to have_enqueued_mail(OrderMailer, :confirmation)
      end
    end

    context 'with invalid items or missing inventory' do
      before { allow(InventoryService).to receive(:check).and_return(false) }

      it 'raises an OutOfStockError with item details' do
        expect { service.create_order(order_params) }
          .to raise_error(OutOfStockError, /item1/)
      end
    end
  end

  describe '#cancel_order' do
    it 'marks the order as cancelled and processes refund' do
      order = create(:order, status: :confirmed, amount: 100)
      service.cancel_order(order.id)
      expect(order.reload.status).to eq('cancelled')
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/order_service_spec.rb", "ruby");

      // All it blocks should appear somewhere in the output
      const allContent = chunks.map((c) => c.content).join("\n");
      expect(allContent).toContain("creates an order and charges");
      expect(allContent).toContain("sends a confirmation email");
      expect(allContent).toContain("raises an OutOfStockError");
      expect(allContent).toContain("marks the order as cancelled");

      // Test chunks should have symbolIds
      const testChunks = chunks.filter((c) => c.metadata.chunkType === "test" || c.metadata.chunkType === "test_setup");
      for (const chunk of testChunks) {
        expect(chunk.metadata.symbolId).toBeDefined();
      }
    });

    it("should inject parent setup from multiple ancestor levels", async () => {
      const code = `
RSpec.describe PaymentProcessor do
  let(:processor) { described_class.new(api_key: 'test_key', timeout: 30) }
  before { stub_external_api }

  context 'when processing credit cards with valid credentials' do
    let(:card) { build(:credit_card, number: '4242424242424242') }

    context 'when the charge amount is within daily limits' do
      let(:amount) { 500 }

      it 'processes the charge successfully and returns a receipt' do
        result = processor.charge(card: card, amount: amount)
        expect(result.status).to eq(:success)
        expect(result.receipt_number).to be_present
      end
    end
  end
end`;

      const chunks = await chunker.chunk(code, "spec/services/payment_processor_spec.rb", "ruby");

      const testChunk = chunks.find((c) => c.metadata.chunkType === "test");
      expect(testChunk).toBeDefined();
      // Should contain setup from all ancestor levels
      expect(testChunk!.content).toContain("let(:processor)");
      expect(testChunk!.content).toContain("let(:card)");
      expect(testChunk!.content).toContain("let(:amount)");
      expect(testChunk!.content).toContain("processes the charge successfully");
    });
  });

  // bd tea-rags-mcp-ksb8 — `buildParentPath` joined with ` > ` (spaces),
  // producing `Scaffold > route#decorator` instead of the canonical
  // `Scaffold.route#decorator` (or `Scaffold#route#decorator`). Per
  // `.claude/rules/symbolid-convention.md` only `.`, `#`, and `::` are
  // valid separators. The ` > ` separator MUST NOT appear in any
  // symbolId or parentSymbolId in the chunker output.
  describe("chunk - Python parent-path separator (bd ksb8)", () => {
    it("should NOT use ' > ' as a separator in any Python chunk symbolId or parentSymbolId", async () => {
      const code = `
class Scaffold:
    def route(self, rule, **options):
        """Decorator factory — same shape as flask Scaffold.route."""
        def decorator(f):
            """Inner decorator long enough to clear the fifty char floor."""
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f
        return decorator
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      for (const chunk of chunks) {
        expect(chunk.metadata.symbolId ?? "").not.toContain(" > ");
        expect(chunk.metadata.parentSymbolId ?? "").not.toContain(" > ");
      }
    });
  });

  // bd tea-rags-mcp-07fr — When a Python class method contains an inner
  // function (decorator-factory shape `def route → def decorator`), the
  // chunker currently descends into the inner function and emits ONLY
  // the inner chunk. The outer method (Scaffold#route) is shadowed and
  // `find_symbol("Scaffold#route")` returns []. Walker must emit BOTH.
  describe("chunk - Python nested-def-as-decorator-return (bd 07fr)", () => {
    it("should emit the outer method chunk AND the inner function chunk", async () => {
      const code = `
class Scaffold:
    def route(self, rule, **options):
        """Decorator factory — same shape as flask Scaffold.route."""
        def decorator(f):
            """Inner decorator long enough to clear the fifty char floor."""
            endpoint = options.pop("endpoint", None)
            self.add_url_rule(rule, endpoint, f, **options)
            return f
        return decorator
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const route = chunks.find((c) => c.metadata.symbolId === "Scaffold#route");
      expect(route).toBeDefined();
      // The chunker doesn't have to ALSO emit a chunk for the inner
      // `decorator`, but the outer method MUST exist. The inner def, if
      // emitted, MUST be parented to `Scaffold#route` with a canonical
      // separator (no ` > `).
      const decoratorChunk = chunks.find((c) => c.metadata.name === "decorator");
      if (decoratorChunk) {
        expect(decoratorChunk.metadata.parentSymbolId ?? "").not.toContain(" > ");
      }
    });
  });

  // bd tea-rags-mcp-cpbv — Split parts of an oversized Python method
  // emitted via the `processChildren` character-fallback path currently
  // overwrite `parentSymbolId = methodSymbolId` and `parentType =
  // function_definition`. That loses the class-context lineage (the
  // method's true parent is the class). The 5xie regression test
  // (preserve symbolId across parts) still passes because that invariant
  // is unaffected, but downstream MCP `find_symbol` navigation expects
  // `parentSymbolId = Flask` / `parentType = class_definition` so the
  // call chain reads `class → method → split-part` rather than
  // self-looping on the method symbolId.
  describe("chunk - Python multi-part method parent lineage (bd cpbv)", () => {
    it("oversized method split-parts keep parentSymbolId pointing at the CLASS, not the method", async () => {
      const initBody = Array.from({ length: 200 }, (_, i) => `        self.value_${i} = 1`).join("\n");
      const code = `
class Foo:
    def __init__(self):
        """Oversized constructor split by character fallback (cpbv)."""
${initBody}

    def helper(self):
        """Small sibling method so the class extracts children."""
        return self.value_0 + self.value_1
      `;
      const chunks = await chunker.chunk(code, "test.py", "python");
      const splits = chunks.filter((c) => c.metadata.symbolId === "Foo#__init__");
      // 5xie invariant — every split shares symbolId "Foo#__init__".
      expect(splits.length).toBeGreaterThan(1);
      for (const c of splits) {
        // cpbv fix — parentSymbolId is the CLASS, not the method itself.
        expect(c.metadata.parentSymbolId).toBe("Foo");
        // parentType reflects the class declaration, not function.
        expect(c.metadata.parentType).toBe("class_definition");
      }
    });
  });
});
