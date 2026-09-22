/**
 * Swift container-body chunk — the type-level chunk that carries the
 * declaration header plus whatever sits above the first member.
 *
 * This hook exists because of an engine branch, not because Swift wanted
 * richer body grouping: `chunkWithChildExtraction` emits the narrow parent
 * class chunk ONLY for languages with no hook chain, and switches to
 * `ctx.bodyChunks` the moment a language registers one. Adding any Swift hook
 * therefore deletes the type chunk unless the chain re-emits it. These tests
 * pin that the output matches the pre-hook narrow chunk, minus the doc-comment
 * rows the capture hook has claimed.
 */

import { describe, expect, it } from "vitest";

import { extractSwiftContainerBody } from "../../../../../../src/core/domains/language/swift/chunking/container-body-chunker.js";
import { swiftDocCommentCaptureHook } from "../../../../../../src/core/domains/language/swift/chunking/doc-comment-capture.js";
import { chunkFor, chunkSwift, parseSwiftContainer } from "./__helpers__/swift-chunking.js";

describe("extractSwiftContainerBody", () => {
  it("collects the rows between the header and the first member, header excluded", async () => {
    const { ctx } = await parseSwiftContainer(`final class LedgerTests: XCTestCase {
    var ledger: Ledger!
    var clock: TestClock!

    override func setUp() {
        super.setUp()
        ledger = Ledger(period: .january)
    }
}`);

    const body = extractSwiftContainerBody(ctx);

    expect(body).toHaveLength(1);
    // Indentation of the first body row is preserved — the engine's pre-hook
    // slice kept it, and the emitted chunk text must stay byte-identical.
    expect(body[0].content).toBe("    var ledger: Ledger!\n    var clock: TestClock!");
    expect(body[0].content).not.toContain("class LedgerTests");
  });

  it("drops rows the doc-comment hook already claimed", async () => {
    const { ctx } = await parseSwiftContainer(`public struct Ledger {
    var entries: [Invoice] = []

    /// Adds an invoice to the ledger.
    /// - Returns: the running total.
    public mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return total
    }
}`);

    swiftDocCommentCaptureHook.process(ctx);
    const body = extractSwiftContainerBody(ctx);

    expect(body[0].content).toBe("    var entries: [Invoice] = []");
    expect(body[0].content).not.toContain("///");
  });

  it("drops a body under the length floor rather than emitting a near-bare header", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    var n = 0

    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(extractSwiftContainerBody(ctx)).toEqual([]);
  });

  it("emits nothing when only the header precedes the first member", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(extractSwiftContainerBody(ctx)).toEqual([]);
  });

  it("emits nothing when the container has no extracted members", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    var entries: [Invoice] = []
}`);

    expect(extractSwiftContainerBody(ctx)).toEqual([]);
  });

  it("labels the body of a recognized suite test_setup, and a production type class", async () => {
    const suite = await parseSwiftContainer(
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
    const production = await parseSwiftContainer(
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

    expect(extractSwiftContainerBody(suite.ctx)[0].chunkType).toBe("test_setup");
    expect(extractSwiftContainerBody(production.ctx)[0].chunkType).toBe("class");
  });
});

describe("container body end to end", () => {
  it("still emits the type chunk once the hook chain is wired", async () => {
    const chunks = await chunkSwift(
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

    const typeChunk = chunkFor(chunks, "Ledger");
    expect(typeChunk).toBeDefined();
    expect(typeChunk?.metadata.chunkType).toBe("class");
    expect(typeChunk?.content).toContain("public struct Ledger {");
    expect(typeChunk?.content).toContain("var entries: [Invoice] = []");
  });

  it("keeps an XCTest suite's fixture block out of the source scope by labelling it test_setup", async () => {
    const chunks = await chunkSwift(
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

    expect(chunkFor(chunks, "LedgerTests")?.metadata.chunkType).toBe("test_setup");
  });
});
