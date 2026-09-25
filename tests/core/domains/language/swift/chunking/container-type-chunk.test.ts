/**
 * Swift type-level chunk — the chunk that carries a container's own rows (its
 * header, stored properties, computed properties) next to the member chunks.
 *
 * Swift once emitted it from its own `swiftContainerBodyChunkerHook`, a port of
 * the engine's pre-deoki narrow parent (the rows ABOVE the first member). Since
 * bd tea-rags-mcp-deoki the ENGINE emits it for every unclaimed container as the
 * container remainder — every row no member carries — so the hook was retired.
 * These specs pin the same invariants the hook's own unit specs pinned, now
 * through the whole chunker (rewritten from direct `extractSwiftContainerBody`
 * calls when that function was deleted), plus the rows BELOW the first member
 * the hook never carried.
 */

import { describe, expect, it } from "vitest";

import { chunkFor, chunkSwift } from "./__helpers__/swift-chunking.js";

describe("swift type-level chunk (engine container remainder)", () => {
  it("carries the rows between the header and the first member, with the header", async () => {
    const chunks = await chunkSwift(
      `final class LedgerTests: XCTestCase {
    var ledger: Ledger!
    var clock: TestClock!

    override func setUp() {
        super.setUp()
        ledger = Ledger(period: .january)
    }
}`,
    );

    const typeChunk = chunkFor(chunks, "LedgerTests");
    expect(typeChunk?.content).toContain("final class LedgerTests: XCTestCase {");
    expect(typeChunk?.content).toContain("    var ledger: Ledger!\n    var clock: TestClock!");
    expect(typeChunk?.content).not.toContain("super.setUp()");
  });

  it("carries members declared BELOW the first method (bd tea-rags-mcp-deoki)", async () => {
    const chunks = await chunkSwift(
      `public struct InvoiceLine {
    public let description: String

    public mutating func scale(by factor: Int) {
        quantity *= factor
        lastScaledAt = Date()
    }

    public var total: Decimal {
        return Decimal(quantity) * unitPrice
    }
}`,
      "Sources/Billing/InvoiceLine.swift",
    );

    const typeChunk = chunkFor(chunks, "InvoiceLine");
    expect(typeChunk?.content).toContain("public var total: Decimal {");
    expect(typeChunk?.content).not.toContain("quantity *= factor");
    expect(typeChunk?.metadata.lineRanges).toEqual([
      { start: 1, end: 2 },
      { start: 9, end: 12 },
    ]);
  });

  it("leaves out rows the doc-comment hook already claimed for a member", async () => {
    const chunks = await chunkSwift(
      `public struct Ledger {
    var entries: [Invoice] = []
    var lastResetAt: Date = .distantPast

    /// Adds an invoice to the ledger.
    /// - Returns: the running total.
    public mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return total
    }
}`,
      "Sources/Billing/Ledger.swift",
    );

    expect(chunkFor(chunks, "Ledger")?.content).not.toContain("///");
    expect(chunkFor(chunks, "Ledger#add")?.content).toContain("/// Adds an invoice to the ledger.");
  });

  it("drops a body under the length floor rather than emitting a near-bare header", async () => {
    const chunks = await chunkSwift(`struct Ledger {
    var n = 0

    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(chunkFor(chunks, "Ledger")).toBeUndefined();
  });

  it("emits nothing when only the header precedes the first member", async () => {
    const chunks = await chunkSwift(`public struct LedgerWithAVeryLongNameThatClearsTheFloor {
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(chunkFor(chunks, "LedgerWithAVeryLongNameThatClearsTheFloor")).toBeUndefined();
  });

  it("labels a recognized suite's type chunk test_setup, and a production type's class", async () => {
    const suite = await chunkSwift(
      `final class LedgerTests: XCTestCase {
    var ledger: Ledger!
    var clock: TestClock!

    func testAddIncreasesTotal() {
        ledger.add(invoice: Invoice(total: 10))
        XCTAssertEqual(ledger.total, 10)
    }
}`,
      "Tests/BillingTests/LedgerTests.swift",
    );
    const production = await chunkSwift(
      `public struct Ledger {
    var entries: [Invoice] = []
    var lastResetAt: Date = .distantPast

    public mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`,
      "Sources/Billing/Ledger.swift",
    );

    expect(chunkFor(suite, "LedgerTests")?.metadata.chunkType).toBe("test_setup");
    expect(chunkFor(production, "Ledger")?.metadata.chunkType).toBe("class");
    expect(chunkFor(production, "Ledger")?.content).toContain("var entries: [Invoice] = []");
  });
});
