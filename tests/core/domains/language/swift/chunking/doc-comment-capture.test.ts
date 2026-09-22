/**
 * Swift doc-comment capture — `///` runs, block doc comments, and the
 * `// MARK:` boundary.
 *
 * Baseline this replaces: the generic chunker slices a chunk as
 * `code.substring(node.startIndex, node.endIndex)`, and a Swift doc comment is
 * a preceding SIBLING of the declaration, so it fell outside every method chunk
 * and was orphaned into the enclosing type chunk. TypeScript and Ruby each
 * solve this with a per-language capture hook; these tests pin the Swift one.
 */

import { describe, expect, it } from "vitest";

import {
  collectSwiftDocComments,
  swiftDocCommentCaptureHook,
} from "../../../../../../src/core/domains/language/swift/chunking/doc-comment-capture.js";
import { chunkFor, chunkSwift, memberDeclarations, parseSwiftContainer } from "./__helpers__/swift-chunking.js";

describe("collectSwiftDocComments", () => {
  it("collects a consecutive /// run in source order", async () => {
    const { members, ctx } = await parseSwiftContainer(`struct Ledger {
    /// Adds an invoice to the ledger.
    /// - Parameter invoice: the invoice to add.
    /// - Returns: the running total after the insert.
    mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return total
    }
}`);

    const comments = collectSwiftDocComments(members[0], ctx.codeLines);

    expect(comments.map((c) => c.text)).toEqual([
      "/// Adds an invoice to the ledger.",
      "/// - Parameter invoice: the invoice to add.",
      "/// - Returns: the running total after the insert.",
    ]);
  });

  it("collects a /** … */ block, which parses as multiline_comment, not comment", async () => {
    const { members, ctx } = await parseSwiftContainer(`struct Ledger {
    /**
     Removes every entry from the ledger.
     Useful between billing periods.
     */
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    const comments = collectSwiftDocComments(members[0], ctx.codeLines);

    expect(comments).toHaveLength(1);
    expect(comments[0].type).toBe("multiline_comment");
    expect(comments[0].text).toContain("Removes every entry from the ledger.");
  });

  it("stops at a // MARK: section marker and does not capture it", async () => {
    const { members, ctx } = await parseSwiftContainer(`struct Ledger {
    /// Belongs to the section above the marker.
    // MARK: - Private helpers
    private func validate(invoice: Invoice) -> Bool {
        return invoice.total > Decimal.zero
    }
}`);

    expect(collectSwiftDocComments(members[0], ctx.codeLines)).toEqual([]);
  });

  it("does not reach across two or more blank lines", async () => {
    const { members, ctx } = await parseSwiftContainer(`struct Ledger {
    /// A floating note about the type, not about the method.


    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(collectSwiftDocComments(members[0], ctx.codeLines)).toEqual([]);
  });

  it("still reaches across a single blank line", async () => {
    const { members, ctx } = await parseSwiftContainer(`struct Ledger {
    /// Documents the method just below.

    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(collectSwiftDocComments(members[0], ctx.codeLines).map((c) => c.text)).toEqual([
      "/// Documents the method just below.",
    ]);
  });
});

describe("swiftDocCommentCaptureHook", () => {
  it("prefixes the member, backs its start line up, and excludes the comment rows", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    /// Adds an invoice to the ledger.
    /// - Returns: the running total.
    mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return total
    }
}`);

    swiftDocCommentCaptureHook.process(ctx);

    expect(ctx.methodPrefixes.get(0)).toBe("/// Adds an invoice to the ledger.\n/// - Returns: the running total.");
    // 1-based line of the first comment row.
    expect(ctx.methodStartLines.get(0)).toBe(2);
    // 0-based rows of both comment lines, so the container body chunk drops them.
    expect([...ctx.excludedRows].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("writes nothing for a member with no preceding comment", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    swiftDocCommentCaptureHook.process(ctx);

    expect(ctx.methodPrefixes.size).toBe(0);
    expect(ctx.excludedRows.size).toBe(0);
  });

  it("leaves bodyChunks untouched so the chain does not short-circuit", async () => {
    const { ctx } = await parseSwiftContainer(`struct Ledger {
    /// Adds an invoice to the ledger.
    mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return total
    }
}`);

    swiftDocCommentCaptureHook.process(ctx);

    expect(ctx.bodyChunks).toEqual([]);
  });

  it("captures the init declaration's doc comment too", async () => {
    const code = `struct Ledger {
    /// Builds an empty ledger for the given period.
    init(period: BillingPeriod) {
        self.period = period
        self.entries = []
    }
}`;
    const { ctx } = await parseSwiftContainer(code);
    expect(memberDeclarations((await parseSwiftContainer(code)).container)[0].type).toBe("init_declaration");

    swiftDocCommentCaptureHook.process(ctx);

    expect(ctx.methodPrefixes.get(0)).toBe("/// Builds an empty ledger for the given period.");
  });
});

describe("doc comments end to end", () => {
  it("carries the /// run into the method chunk and starts the chunk at the comment", async () => {
    const chunks = await chunkSwift(`public struct Ledger {
    /// Adds an invoice to the ledger and returns the new total.
    /// - Parameter invoice: the invoice to add.
    public mutating func add(invoice: Invoice) -> Decimal {
        entries.append(invoice)
        return entries.reduce(Decimal.zero) { $0 + $1.total }
    }
}`);

    const chunk = chunkFor(chunks, "Ledger#add");
    expect(chunk).toBeDefined();
    expect(chunk?.content).toContain("/// Adds an invoice to the ledger and returns the new total.");
    expect(chunk?.content).toContain("/// - Parameter invoice: the invoice to add.");
    expect(chunk?.content.indexOf("///")).toBeLessThan(chunk?.content.indexOf("public mutating func add") ?? -1);
    expect(chunk?.startLine).toBe(2);
  });

  it("carries a /** … */ block into the method chunk", async () => {
    const chunks = await chunkSwift(`public struct Ledger {
    /**
     Removes every entry from the ledger.
     Useful between billing periods.
     */
    public mutating func reset() {
        entries.removeAll()
        lastResetAt = Date()
    }
}`);

    expect(chunkFor(chunks, "Ledger#reset")?.content).toContain("Removes every entry from the ledger.");
  });

  it("leaves a // MARK: marker out of the method chunk it precedes", async () => {
    const chunks = await chunkSwift(`public struct Ledger {
    // MARK: - Private helpers

    private func validate(invoice: Invoice) -> Bool {
        return invoice.total > Decimal.zero && invoice.id.isEmpty == false
    }
}`);

    expect(chunkFor(chunks, "Ledger#validate")?.content).not.toContain("MARK:");
  });
});
