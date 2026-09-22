/**
 * Swift tier-1 chunking — symbolId composition through the real
 * tree-sitter-swift grammar. The per-language detection contract these
 * symbolIds encode lives in `src/core/infra/symbolid/classify.ts`
 * (`.claude/rules/symbolid-convention.md`); the tree-sitter-swift node shapes
 * it reads are non-obvious (one `class_declaration` node for five keywords,
 * the `class` modifier arriving as a bare keyword child), so each convention
 * gets a real-parse assertion here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../src/core/types.js";

const FIXTURES = join("tests/__fixtures__/sample-swift");

const testLanguageFactory = new LanguageFactory();

describe("TreeSitterChunker — swift", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
      new DefaultSymbolIdComposer(),
      testLanguageFactory,
    );
  });

  const chunkCode = async (code: string, name = "Sample.swift"): Promise<CodeChunk[]> =>
    chunker.chunk(code, name, "swift");

  const symbolIds = (chunks: CodeChunk[]): string[] => chunks.map((c) => c.metadata.symbolId ?? "");

  describe("symbolId composition", () => {
    it("composes an instance method with # and a static method with .", async () => {
      const chunks = await chunkCode(`
class Vehicle {
    func drive() {
        let x = 1
        print(x)
    }

    class func makeDefault() -> Vehicle {
        return Vehicle()
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Vehicle#drive");
      expect(symbolIds(chunks)).toContain("Vehicle.makeDefault");
    });

    it("reads the `static` keyword out of the modifiers wrapper", async () => {
      const chunks = await chunkCode(`
class Builder {
    static func build() -> Builder {
        return Builder()
    }

    private static func shared() -> Builder {
        return Builder()
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Builder.build");
      expect(symbolIds(chunks)).toContain("Builder.shared");
    });

    it("keeps a mutating func an instance method", async () => {
      const chunks = await chunkCode(`
struct Counter {
    mutating func bump() {
        value += 1
        history.append(value)
        notifyObserversIfNeeded()
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Counter#bump");
    });

    it("composes inits as instance members and disambiguates overloads with ~N", async () => {
      const chunks = await chunkCode(`
class Invoice {
    public init(number: String) {
        self.number = number
    }

    public convenience init() {
        self.init(number: "INV-0001")
    }

    func total() -> Int {
        return lines.reduce(0) { $0 + $1.amount }
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Invoice#init");
      expect(symbolIds(chunks)).toContain("Invoice#init~2");
      expect(symbolIds(chunks)).toContain("Invoice#total");
    });

    it("attributes extension methods to the extended type", async () => {
      const chunks = await chunkCode(`
class Vehicle {}

extension Vehicle {
    func honk() {
        let message = "beep"
        print(message)
        engine.revOnce()
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Vehicle#honk");
    });

    it("composes nested types with the scope separator", async () => {
      const chunks = await chunkCode(`
class Ledger {
    class Account {
        func post() {
            balance += 1
            journal.append(entry)
            notifyObserversIfNeeded()
        }
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Ledger.Account#post");
    });

    it("chunks struct and enum bodies through the same class_declaration node", async () => {
      const chunks = await chunkCode(`
struct Point {
    var x: Double = 0.0
    var y: Double = 0.0
    private var history: [Double] = []

    func reset() {
        x = 0
        y = 0
        history.append(self)
    }
}

enum Direction {
    case north

    func opposite() -> Direction {
        return .south
    }
}
      `);

      expect(symbolIds(chunks)).toContain("Point#reset");
      expect(symbolIds(chunks)).toContain("Direction#opposite");
      // Both containers keep their chunkType "class" — the node type is
      // class_declaration even under the struct / enum keywords.
      expect(chunks.filter((c) => c.metadata.symbolId === "Point").map((c) => c.metadata.chunkType)).toEqual(["class"]);
    });

    it("emits signature-only protocol requirements below the 50-char floor", async () => {
      const chunks = await chunkCode(`
protocol Shape {
    func draw()
    static func supports() -> Bool
}
      `);

      expect(symbolIds(chunks)).toContain("Shape#draw");
      expect(symbolIds(chunks)).toContain("Shape.supports");
    });

    it("composes top-level functions with the bare name form", async () => {
      const chunks = await chunkCode(`
func formatDecimal(_ value: Int) -> String {
    return String(value)
}
      `);

      expect(symbolIds(chunks)).toContain("formatDecimal");
    });

    it("does not chunk property, subscript, deinit or typealias declarations (tier-1 scope)", async () => {
      const chunks = await chunkCode(`
class Store {
    var items: [String] = []
    var computed: Int {
        return items.count
    }

    subscript(index: Int) -> String {
        return items[index]
    }

    deinit {
        print("bye")
    }
}

typealias Handler = (Int) -> Void
      `);

      expect(symbolIds(chunks)).toEqual(["Store"]);
    });
  });

  describe("sample fixtures", () => {
    it("assigns the convention's symbolIds across the invoice fixture", async () => {
      const code = readFileSync(join(FIXTURES, "Invoice.swift"), "utf8");
      const chunks = await chunker.chunk(code, "Invoice.swift", "swift");
      const ids = new Set(symbolIds(chunks));

      // struct body through the shared class_declaration node
      expect(ids.has("InvoiceLine#init")).toBe(true);
      expect(ids.has("InvoiceLine#scale")).toBe(true);
      // enum method
      expect(ids.has("InvoiceState#transition")).toBe(true);
      // convenience init overload
      expect(ids.has("Invoice#init~2")).toBe(true);
      // static + extension method
      expect(ids.has("Invoice.empty")).toBe(true);
      expect(ids.has("Invoice#totalsByQuantity")).toBe(true);
      // computed properties and stored properties are tier-1 skipped
      expect([...ids].some((id) => id.includes("total") && !id.startsWith("Invoice#total"))).toBe(false);
    });

    it("assigns the convention's symbolIds across the ledger fixture", async () => {
      const code = readFileSync(join(FIXTURES, "Ledger.swift"), "utf8");
      const chunks = await chunker.chunk(code, "Ledger.swift", "swift");
      const ids = new Set(symbolIds(chunks));

      // nested type + its static factory
      expect(ids.has("Ledger.Account#post")).toBe(true);
      expect(ids.has("Ledger.Account.opening")).toBe(true);
      // same-name overloads disambiguate in declaration order
      expect(ids.has("Ledger#balance")).toBe(true);
      expect(ids.has("Ledger#balance~2")).toBe(true);
      // protocol requirement signatures, instance and static
      expect(ids.has("LedgerExporting#export")).toBe(true);
      expect(ids.has("LedgerExporting.supports")).toBe(true);
      // conforming type
      expect(ids.has("CsvExporter#export")).toBe(true);
      expect(ids.has("CsvExporter.supports")).toBe(true);
      // top-level function
      expect(ids.has("formatDecimal")).toBe(true);
    });
  });
});
