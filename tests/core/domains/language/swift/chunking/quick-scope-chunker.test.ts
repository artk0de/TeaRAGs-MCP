/**
 * Swift Quick/Nimble scope chunker — the canonical DSL test-spec structure
 * (`.claude/rules/test-spec-chunking.md`) applied to a trailing-closure DSL
 * that lives inside `override class func spec()`.
 *
 * Two things the Ruby and TypeScript mirrors never had to answer, and which
 * these tests pin:
 *
 *   - ENTRY. The scope tree is ROOTED at the `spec()` method, but the container
 *     the hook CLAIMS is the type declaring it — the engine tests a child for
 *     oversize before it tests whether the child is a container, so a spec
 *     method above `maxChunkSize` would never get a context of its own.
 *   - CO-EXISTENCE. `swiftContainerBodyChunkerHook` already owns
 *     `ctx.bodyChunks` for that same node, so the two writers are ordered, not
 *     partitioned: the scope chunker takes first refusal and abstains on
 *     everything that is not a Quick suite, and its claim carries a residue
 *     chunk standing in for the type-level chunk the body chunker would have
 *     emitted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHookContext } from "../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/types.js";
import {
  buildQuickScopeTree,
  produceQuickScopeChunks,
  swiftQuickScopeChunkerHook,
} from "../../../../../../src/core/domains/language/swift/chunking/quick-scope-chunker.js";
import {
  classifySwiftSuiteMember,
  detectSwiftSuiteKind,
} from "../../../../../../src/core/domains/language/swift/chunking/suite-recognition.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";
import { chunkFor, chunkSwift, findFirst, memberDeclarations, parseSwift } from "./__helpers__/swift-chunking.js";

const SPEC_PATH = join("tests/__fixtures__/sample-swift/Tests/InvoiceSpec.swift");
const SPEC_SOURCE = readFileSync(SPEC_PATH, "utf8");

const XCTEST_SUITE = `import XCTest

final class LedgerTests: XCTestCase {
    var ledger: Ledger!

    override func setUp() {
        super.setUp()
        ledger = Ledger(period: .january)
    }

    func testAddIncreasesTotal() {
        ledger.add(invoice: Invoice(total: 10))
        XCTAssertEqual(ledger.total, 10)
    }
}`;

/**
 * The suite type and its `spec()` declaration, plus the hook context the engine
 * builds for that type — `validChildren` is the member list `chunkWithChild-
 * Extraction` would have passed.
 */
async function suiteContext(code = SPEC_SOURCE, filePath = SPEC_PATH, maxChunkSize = 1000) {
  const root = await parseSwift(code);
  const suiteNode = findFirst(root, "class_declaration");
  const members = memberDeclarations(suiteNode);
  const specNode = members.find((m) => m.childForFieldName("name")?.text === "spec") ?? members[0];
  return {
    suiteNode,
    specNode,
    ctx: createHookContext(suiteNode, members, code, { maxChunkSize }, filePath),
  };
}

function chunkTypeOf(chunks: CodeChunk[], symbolId: string): string | undefined {
  return chunkFor(chunks, symbolId)?.metadata.chunkType;
}

describe("buildQuickScopeTree", () => {
  it("roots the tree at the spec method and nests through trailing closures", async () => {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);

    expect(root.name).toBe("spec");
    expect(root.isLeaf).toBe(false);
    expect(root.children.map((c) => c.name)).toEqual(['describe "Invoice"', 'describe "InvoiceLine"']);
  });

  it("collects the spec-level setup and leaves non-DSL statements as other lines", async () => {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);

    expect(root.setupLines).toHaveLength(1);
    expect(root.setupLines[0].text).toContain("beforeEach {");
    expect(root.otherLines.map((o) => o.text.trim())).toEqual(["var invoice: Invoice!"]);
  });

  it("splits a nested context into its own leaf scope with its own setup and examples", async () => {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);
    const invoice = root.children[0];
    const overdue = invoice.children.find((c) => c.name === 'context "when overdue"');

    expect(overdue).toBeDefined();
    expect(overdue?.isLeaf).toBe(true);
    expect(overdue?.setupLines).toHaveLength(1);
    expect(overdue?.ownItBlocks).toHaveLength(2);
  });

  it("keeps an intermediate scope's own examples on the intermediate scope", async () => {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);
    const invoice = root.children[0];

    expect(invoice.isLeaf).toBe(false);
    expect(invoice.ownItBlocks).toHaveLength(1);
    expect(invoice.ownItBlocks[0].text).toContain("starts life as a draft");
  });
});

describe("produceQuickScopeChunks", () => {
  async function chunks() {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);
    return produceQuickScopeChunks(root, "InvoiceSpec", SPEC_SOURCE, { maxChunkSize: 1000 });
  }

  it("addresses every leaf scope under the name the root describe carries", async () => {
    expect((await chunks()).map((c) => c.symbolId)).toEqual([
      'Invoice.context "when overdue"',
      'Invoice.context "when paid"',
      'Invoice.describe "Invoice"',
      'InvoiceLine.describe "InvoiceLine"',
    ]);
  });

  it("labels a leaf with examples a test and an intermediate scope's own examples setup", async () => {
    const produced = await chunks();
    const byId = new Map(produced.map((c) => [c.symbolId, c]));

    expect(byId.get('Invoice.context "when overdue"')?.chunkType).toBe("test");
    expect(byId.get('Invoice.describe "Invoice"')?.chunkType).toBe("test_setup");
  });

  it("carries ancestor setup into the leaf content", async () => {
    const overdue = (await chunks()).find((c) => c.symbolId === 'Invoice.context "when overdue"');

    expect(overdue?.content).toContain('invoice = Invoice(number: "INV-1", total: 100)');
    expect(overdue?.content).toContain("invoice.dueDate = Date.distantPast");
    expect(overdue?.content).toContain("adds a late penalty to the total");
    expect(overdue?.content).not.toContain("when paid");
  });

  it("computes the line range from the scope's own lines, never the ancestor's", async () => {
    const overdue = (await chunks()).find((c) => c.symbolId === 'Invoice.context "when overdue"');

    expect(overdue?.startLine).toBe(16);
    expect(overdue?.endLine).toBe(26);
  });

  it("names the parent symbol without the DSL wrapper", async () => {
    const produced = await chunks();

    expect(produced.map((c) => c.parentSymbolId)).toEqual(["Invoice", "Invoice", "Invoice", "InvoiceLine"]);
    expect(produced[0].name).toBe('context "when overdue"');
  });

  it("splits an oversized leaf into one chunk per example, sharing the symbolId", async () => {
    const { specNode } = await suiteContext();
    const root = buildQuickScopeTree(specNode, SPEC_SOURCE);
    const produced = produceQuickScopeChunks(root, "InvoiceSpec", SPEC_SOURCE, { maxChunkSize: 120 });
    const overdue = produced.filter((c) => c.symbolId === 'Invoice.context "when overdue"');

    expect(overdue).toHaveLength(2);
    expect(overdue[0].content).toContain("adds a late penalty");
    expect(overdue[1].content).toContain("reports itself as late");
  });
});

describe("swiftQuickScopeChunkerHook", () => {
  it("claims the suite type and stops the engine emitting its members", async () => {
    const { ctx } = await suiteContext();
    swiftQuickScopeChunkerHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThan(0);
    expect(ctx.skipChildren).toBe(true);
  });

  it("claims a spec method the engine would have called oversized", async () => {
    const { ctx } = await suiteContext(SPEC_SOURCE, SPEC_PATH, 200);
    swiftQuickScopeChunkerHook.process(ctx);

    expect(ctx.bodyChunks.length).toBeGreaterThan(0);
  });

  it("carries the members skipChildren suppresses as a residue chunk", async () => {
    const { ctx } = await suiteContext();
    swiftQuickScopeChunkerHook.process(ctx);
    const residue = ctx.bodyChunks[0];

    expect(residue.symbolId).toBeUndefined();
    expect(residue.chunkType).toBe("test_setup");
    expect(residue.content).toContain("private static func makeInvoice");
    expect(residue.content).not.toContain("describe(");
  });

  it("abstains on a class that is not a Quick suite, leaving it to the body chunker", async () => {
    const { ctx } = await suiteContext(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");
    swiftQuickScopeChunkerHook.process(ctx);

    expect(ctx.bodyChunks).toEqual([]);
    expect(ctx.skipChildren).toBe(false);
  });

  it("abstains on a production path", async () => {
    const { ctx } = await suiteContext(SPEC_SOURCE, "Sources/Billing/Invoice.swift");
    swiftQuickScopeChunkerHook.process(ctx);

    expect(ctx.bodyChunks).toEqual([]);
  });

  it("abstains on a Quick base class that declares no spec", async () => {
    const base = `class BaseSpec: QuickSpec {
    static let fixtures = Fixtures(seed: 42, locale: .current, clock: .fixed)
}`;
    const { ctx } = await suiteContext(base, "Tests/BillingTests/BaseSpec.swift");
    swiftQuickScopeChunkerHook.process(ctx);

    expect(ctx.bodyChunks).toEqual([]);
  });
});

describe("Quick suite recognition", () => {
  it("labels a QuickSpec subclass", async () => {
    const root = await parseSwift(SPEC_SOURCE);
    expect(detectSwiftSuiteKind(findFirst(root, "class_declaration"), SPEC_PATH)).toBe("quick");
  });

  it("keeps the spec method a test and its helpers setup", async () => {
    const root = await parseSwift(SPEC_SOURCE);
    const members = findFirst(root, "class_body").namedChildren.filter((c) => c.type === "function_declaration");

    expect(classifySwiftSuiteMember(members[0], "quick")).toBe("test");
    expect(classifySwiftSuiteMember(members[1], "quick")).toBe("test_setup");
  });
});

describe("Quick chunking end to end", () => {
  it("addresses a scenario instead of one giant spec chunk", async () => {
    const chunks = await chunkSwift(SPEC_SOURCE, SPEC_PATH);

    expect(chunkTypeOf(chunks, 'Invoice.context "when overdue"')).toBe("test");
    expect(chunkTypeOf(chunks, 'Invoice.context "when paid"')).toBe("test");
    expect(chunkTypeOf(chunks, 'InvoiceLine.describe "InvoiceLine"')).toBe("test");
    expect(chunkFor(chunks, "InvoiceSpec.spec")).toBeUndefined();
  });

  it("still addresses scenarios when the spec method is far over maxChunkSize", async () => {
    // 400 puts the 1218-character `spec()` well past the oversize branch that
    // routes a child to the character fallback — the branch that rules out
    // claiming the method itself. Scope chunks survive it; `InvoiceSpec.spec`
    // (and the `#partN` splits the fallback would produce) must not appear.
    const chunks = await chunkSwift(SPEC_SOURCE, SPEC_PATH, 400);
    const ids = chunks.map((c) => c.metadata.symbolId ?? "");

    expect(ids.some((id) => id.startsWith('Invoice.context "when overdue"'))).toBe(true);
    expect(ids.some((id) => id.startsWith("InvoiceSpec.spec"))).toBe(false);
  });

  it("keeps the suite's other members in the index under the class symbol", async () => {
    const chunks = await chunkSwift(SPEC_SOURCE, SPEC_PATH);
    const suite = chunkFor(chunks, "InvoiceSpec");

    expect(suite?.metadata.chunkType).toBe("test_setup");
    expect(suite?.content).toContain("private static func makeInvoice");
  });

  it("prefixes a scope chunk with the suite header", async () => {
    const chunks = await chunkSwift(SPEC_SOURCE, SPEC_PATH);
    const overdue = chunkFor(chunks, 'Invoice.context "when overdue"');

    expect(overdue?.content).toContain("final class InvoiceSpec: QuickSpec {");
    expect(overdue?.metadata.parentSymbolId).toBe("Invoice");
    expect(overdue?.metadata.parentType).toBe("class_declaration");
  });

  it("leaves an XCTest suite chunked exactly as before", async () => {
    const chunks = await chunkSwift(XCTEST_SUITE, "Tests/BillingTests/LedgerTests.swift");

    expect(chunkTypeOf(chunks, "LedgerTests#testAddIncreasesTotal")).toBe("test");
    expect(chunkTypeOf(chunks, "LedgerTests#setUp")).toBe("test_setup");
  });
});
