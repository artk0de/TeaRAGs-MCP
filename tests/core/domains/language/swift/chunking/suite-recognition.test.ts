/**
 * Swift test-vocabulary recognition — XCTest (`XCTestCase` subclass,
 * `test`-prefixed zero-argument instance methods, the `setUp` / `tearDown`
 * families) and swift-testing (`@Test` / `@Suite` attributes).
 *
 * Deliberately NOT a test-spec DSL chunker, so `.claude/rules/test-spec-chunking.md`
 * does not apply: that canonical structure describes describe/it CALL
 * expressions the generic chunker cannot name, and prescribes a scope tree to
 * flatten their nesting. XCTest has neither. Its cases are ordinary methods the
 * engine already names correctly (`LedgerTests#testAddIncreasesTotal`), so the
 * chunk SHAPE is right today and only the chunkType LABEL is wrong. Claiming
 * the container to re-emit those chunks would move symbolId composition out of
 * the engine, which `.claude/rules/symbolid-convention.md` forbids.
 */

import { describe, expect, it } from "vitest";

import {
  classifySwiftSuiteMember,
  detectSwiftSuiteKind,
  isSwiftTestFile,
  swiftSuiteClassificationHook,
} from "../../../../../../src/core/domains/language/swift/chunking/suite-recognition.js";
import { chunkFor, chunkSwift, parseSwiftContainer } from "./__helpers__/swift-chunking.js";

const XCTEST_SUITE = `import XCTest

final class LedgerTests: XCTestCase {
    var ledger: Ledger!

    override func setUp() {
        super.setUp()
        ledger = Ledger(period: .january)
    }

    override func tearDownWithError() throws {
        ledger = nil
        try super.tearDownWithError()
    }

    func testAddIncreasesTotal() {
        ledger.add(invoice: Invoice(total: 10))
        XCTAssertEqual(ledger.total, 10)
    }

    func testResetClearsEntries() throws {
        ledger.add(invoice: Invoice(total: 10))
        ledger.reset()
        XCTAssertTrue(ledger.isEmpty)
    }

    private func makeInvoice(total: Decimal) -> Invoice {
        return Invoice(id: UUID().uuidString, total: total)
    }
}`;

const SWIFT_TESTING_SUITE = `import Testing

@Suite("Ledger behaviour")
struct LedgerSuite {
    @Test func addsUpEveryInvoice() async throws {
        var ledger = Ledger(period: .january)
        ledger.add(invoice: Invoice(total: 10))
        #expect(ledger.total == 10)
    }

    @Test("clears between periods")
    func resets() {
        var ledger = Ledger(period: .january)
        ledger.reset()
        #expect(ledger.isEmpty)
    }

    init() {
        Ledger.resetGlobalClock()
        Ledger.installTestFormatter()
    }

    func makeInvoice(total: Decimal) -> Invoice {
        return Invoice(id: UUID().uuidString, total: total)
    }
}`;

describe("isSwiftTestFile", () => {
  it.each([
    ["Tests/BillingTests/LedgerTests.swift", true],
    ["Tests/BillingTests/Helpers.swift", true],
    ["LedgerTests.swift", true],
    ["LedgerTest.swift", true],
    ["Sources/Billing/Ledger.swift", false],
    ["Sources/Billing/Latest.swift", false],
    ["Sources/Protest/Manifest.swift", false],
  ])("%s -> %s", (path, expected) => {
    expect(isSwiftTestFile(path)).toBe(expected);
  });
});

describe("detectSwiftSuiteKind", () => {
  it("recognizes an XCTestCase subclass anywhere, including outside a test file", async () => {
    const { container } = await parseSwiftContainer(XCTEST_SUITE, "Sources/Billing/Fixtures.swift");
    expect(detectSwiftSuiteKind(container, "Sources/Billing/Fixtures.swift")).toBe("xctest");
  });

  it("recognizes a @Suite-attributed type", async () => {
    const { container } = await parseSwiftContainer(SWIFT_TESTING_SUITE, "Sources/Billing/Ledger.swift");
    expect(detectSwiftSuiteKind(container, "Sources/Billing/Ledger.swift")).toBe("swift-testing");
  });

  it("recognizes an un-attributed type that holds @Test functions", async () => {
    const code = `struct LedgerChecks {
    @Test func addsUpEveryInvoice() {
        #expect(Ledger(period: .january).total == 0)
    }
}`;
    const { container } = await parseSwiftContainer(code, "Sources/Billing/Ledger.swift");
    expect(detectSwiftSuiteKind(container, "Sources/Billing/Ledger.swift")).toBe("swift-testing");
  });

  it("falls back to the file path for a class that extends a project-local base case", async () => {
    const code = `final class LedgerTests: BaseTestCase {
    func testAddIncreasesTotal() {
        ledger.add(invoice: Invoice(total: 10))
        XCTAssertEqual(ledger.total, 10)
    }
}`;
    const path = "Tests/BillingTests/LedgerTests.swift";
    const { container } = await parseSwiftContainer(code, path);
    expect(detectSwiftSuiteKind(container, path)).toBe("xctest");
  });

  it("does not claim a production type whose method happens to start with test", async () => {
    const code = `final class ConnectionProbe {
    func testConnection() -> Bool {
        return socket.isOpen && socket.handshakeCompleted
    }
}`;
    const path = "Sources/Networking/ConnectionProbe.swift";
    const { container } = await parseSwiftContainer(code, path);
    expect(detectSwiftSuiteKind(container, path)).toBeNull();
  });

  it("does not claim a struct in a test file — an XCTest case lives on a class", async () => {
    const code = `struct InvoiceFactory {
    func testDataBundle() -> [Invoice] {
        return [Invoice(id: "a", total: 1), Invoice(id: "b", total: 2)]
    }
}`;
    const path = "Tests/BillingTests/InvoiceFactory.swift";
    const { container } = await parseSwiftContainer(code, path);
    expect(detectSwiftSuiteKind(container, path)).toBeNull();
  });

  it("does not claim a protocol declaration", async () => {
    const code = `protocol LedgerTesting {
    func testableSnapshot() -> LedgerSnapshot
}`;
    const path = "Tests/BillingTests/LedgerTesting.swift";
    const { container } = await parseSwiftContainer(code, path, "protocol_declaration");
    expect(detectSwiftSuiteKind(container, path)).toBeNull();
  });
});

describe("classifySwiftSuiteMember", () => {
  it("labels XCTest members: cases, setup/teardown, helpers", async () => {
    const { members } = await parseSwiftContainer(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");
    const labels = members.map((m) => classifySwiftSuiteMember(m, "xctest"));
    expect(labels).toEqual(["test_setup", "test_setup", "test", "test", "test_setup"]);
  });

  it("does not treat a test-prefixed method that takes arguments as a case", async () => {
    const code = `final class LedgerTests: XCTestCase {
    func testAmount(for invoice: Invoice) -> Decimal {
        return invoice.total * Decimal(invoice.quantity)
    }
}`;
    const { members } = await parseSwiftContainer(code, "Tests/BillingTests/LedgerTests.swift");
    expect(classifySwiftSuiteMember(members[0], "xctest")).toBe("test_setup");
  });

  it("does not treat a class-level test method as a case", async () => {
    const code = `final class LedgerTests: XCTestCase {
    class func testSuiteWideInvariant() {
        XCTAssertTrue(Ledger.globalInvariantHolds)
    }
}`;
    const { members } = await parseSwiftContainer(code, "Tests/BillingTests/LedgerTests.swift");
    expect(classifySwiftSuiteMember(members[0], "xctest")).toBe("test_setup");
  });

  it("labels swift-testing members: @Test cases, init, plain helpers", async () => {
    const { members } = await parseSwiftContainer(SWIFT_TESTING_SUITE, "Tests/BillingTests/LedgerSuite.swift");
    const labels = members.map((m) => classifySwiftSuiteMember(m, "swift-testing"));
    expect(labels).toEqual(["test", "test", "test_setup", "test_setup"]);
  });
});

describe("swiftSuiteClassificationHook", () => {
  it("labels every valid child of a recognized suite", async () => {
    const { ctx } = await parseSwiftContainer(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");

    swiftSuiteClassificationHook.process(ctx);

    expect([...ctx.methodChunkTypes.values()]).toEqual(["test_setup", "test_setup", "test", "test", "test_setup"]);
  });

  it("labels nothing for a production type", async () => {
    const { ctx } = await parseSwiftContainer(
      `struct Ledger {
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`,
      "Sources/Billing/Ledger.swift",
    );

    swiftSuiteClassificationHook.process(ctx);

    expect(ctx.methodChunkTypes.size).toBe(0);
  });

  it("leaves bodyChunks untouched so the chain does not short-circuit", async () => {
    const { ctx } = await parseSwiftContainer(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");

    swiftSuiteClassificationHook.process(ctx);

    expect(ctx.bodyChunks).toEqual([]);
  });
});

describe("suite recognition end to end", () => {
  it("emits chunkType test for XCTest cases and test_setup for the harness around them", async () => {
    const chunks = await chunkSwift(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");

    expect(chunkFor(chunks, "LedgerTests#testAddIncreasesTotal")?.metadata.chunkType).toBe("test");
    expect(chunkFor(chunks, "LedgerTests#testResetClearsEntries")?.metadata.chunkType).toBe("test");
    expect(chunkFor(chunks, "LedgerTests#setUp")?.metadata.chunkType).toBe("test_setup");
    expect(chunkFor(chunks, "LedgerTests#tearDownWithError")?.metadata.chunkType).toBe("test_setup");
    expect(chunkFor(chunks, "LedgerTests#makeInvoice")?.metadata.chunkType).toBe("test_setup");
  });

  it("emits chunkType test for swift-testing cases", async () => {
    const chunks = await chunkSwift(SWIFT_TESTING_SUITE, "Tests/BillingTests/LedgerSuite.swift");

    expect(chunkFor(chunks, "LedgerSuite#addsUpEveryInvoice")?.metadata.chunkType).toBe("test");
    expect(chunkFor(chunks, "LedgerSuite#resets")?.metadata.chunkType).toBe("test");
    expect(chunkFor(chunks, "LedgerSuite#init")?.metadata.chunkType).toBe("test_setup");
    expect(chunkFor(chunks, "LedgerSuite#makeInvoice")?.metadata.chunkType).toBe("test_setup");
  });

  it("labels a nested @Suite, whose symbolId the kernel's scope containers already compose", async () => {
    const chunks = await chunkSwift(
      `import Testing

@Suite("Invoice")
struct InvoiceTests {
    @Test func totalsLineItems() {
        let invoice = Invoice(lines: [1, 2, 3])
        #expect(invoice.total == 6)
    }

    @Suite("when overdue")
    struct WhenOverdue {
        @Test func addsPenalty() {
            let invoice = Invoice(lines: [10], dueDaysAgo: 5)
            #expect(invoice.total == 11)
        }
    }
}`,
      "Tests/BillingTests/InvoiceTests.swift",
    );

    expect(chunkFor(chunks, "InvoiceTests#totalsLineItems")?.metadata.chunkType).toBe("test");
    expect(chunkFor(chunks, "InvoiceTests.WhenOverdue#addsPenalty")?.metadata.chunkType).toBe("test");
  });

  it("keeps production methods on chunkType function", async () => {
    const chunks = await chunkSwift(
      `struct Ledger {
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`,
      "Sources/Billing/Ledger.swift",
    );

    expect(chunkFor(chunks, "Ledger#reset")?.metadata.chunkType).toBe("function");
  });

  it("keeps the label on an oversized case the character fallback splits", async () => {
    const filler = Array.from(
      { length: 40 },
      (_, i) => `        XCTAssertEqual(ledger.entries[${i}].total, Decimal(${i}))`,
    ).join("\n");
    const chunks = await chunkSwift(
      `final class LedgerTests: XCTestCase {
    func testEveryEntryLandsInOrder() {
${filler}
    }
}`,
      "Tests/BillingTests/LedgerTests.swift",
      400,
    );

    // The split parts share the composed method symbolId; `enforceMaxChunkSize`
    // then appends its own `#partN` suffix on top.
    const parts = chunks.filter((c) => c.metadata.symbolId?.startsWith("LedgerTests#testEveryEntryLandsInOrder"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((c) => c.metadata.chunkType === "test")).toBe(true);
  });
});
