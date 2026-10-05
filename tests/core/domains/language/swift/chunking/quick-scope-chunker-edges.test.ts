/**
 * Quick/Nimble specs whose scope tree is thin or oddly shaped: an empty
 * `spec()`, a `describe` with no name, examples directly under `spec()`, a
 * scope with nothing but loose statements, examples too short to index on their
 * own. The scope chunker either emits a chunk that still addresses the right
 * lines or abstains and leaves the suite to the generic body chunker; it never
 * emits an empty chunk and never throws.
 */

import { describe, expect, it } from "vitest";

import { createHookContext } from "../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/types.js";
import {
  buildQuickScopeTree,
  produceQuickScopeChunks,
  swiftQuickScopeChunkerHook,
} from "../../../../../../src/core/domains/language/swift/chunking/quick-scope-chunker.js";
import { findFirst, memberDeclarations, parseSwift } from "./__helpers__/swift-chunking.js";

const SPEC_PATH = "Tests/BillingTests/LedgerSpec.swift";

function quickSpec(specBody: string[], extraMembers: string[] = []): string {
  return [
    "import Quick",
    "import Nimble",
    "",
    "final class LedgerSpec: QuickSpec {",
    ...extraMembers.map((l) => `    ${l}`),
    "    override class func spec() {",
    ...specBody.map((l) => `        ${l}`),
    "    }",
    "}",
    "",
  ].join("\n");
}

async function hookRun(code: string, maxChunkSize = 1000) {
  const root = await parseSwift(code);
  const suiteNode = findFirst(root, "class_declaration");
  const members = memberDeclarations(suiteNode);
  const specNode = members.find((m) => m.childForFieldName("name")?.text === "spec") ?? members[0];
  const ctx = createHookContext(suiteNode, members, code, { maxChunkSize }, SPEC_PATH);
  swiftQuickScopeChunkerHook.process(ctx);
  return { ctx, specNode };
}

const LONG_EXAMPLE = [
  'it("adds an invoice to the running total of the ledger") {',
  "    ledger.add(invoice: Invoice(total: 10))",
  "    expect(ledger.total).to(equal(10))",
  "}",
];

describe("Quick scope chunker — thin and odd spec shapes", () => {
  it("abstains on a spec() with an empty body", async () => {
    const { ctx } = await hookRun(quickSpec([]));

    expect(ctx.bodyChunks).toEqual([]);
    expect(ctx.skipChildren).toBe(false);
  });

  it("names a describe that has no argument after the scope it opens", async () => {
    const code = quickSpec(["describe {", ...LONG_EXAMPLE.map((l) => `    ${l}`), "}"]);
    const { specNode } = await hookRun(code);

    const produced = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 1000,
    });

    expect(produced).toHaveLength(1);
    expect(produced[0].content).toContain("adds an invoice to the running total");
  });

  it("chunks examples written directly under spec() as one test chunk under the suite name", async () => {
    const code = quickSpec(LONG_EXAMPLE);
    const { specNode } = await hookRun(code);

    const produced = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 1000,
    });

    expect(produced).toHaveLength(1);
    expect(produced[0].symbolId).toBe("LedgerSpec.spec");
    expect(produced[0].chunkType).toBe("test");
    expect(produced[0].content).toContain("expect(ledger.total)");
  });

  it("emits nothing for a scope that holds neither setup nor examples", async () => {
    const code = quickSpec(['describe("empty") {', "}", ...[]]);
    const { ctx, specNode } = await hookRun(code);

    expect(
      produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, { maxChunkSize: 1000 }),
    ).toEqual([]);
    expect(ctx.bodyChunks).toEqual([]);
  });

  it("drops examples too short to index on their own, keeping the long one beside them", async () => {
    const code = quickSpec([
      'describe("Ledger") {',
      '    it("a") { expect(1).to(equal(1)) }',
      ...LONG_EXAMPLE.map((l) => `    ${l}`),
      "}",
    ]);
    const { specNode } = await hookRun(code);

    const whole = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 1000,
    });
    const split = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 90,
    });

    expect(whole).toHaveLength(1);
    expect(split.every((c) => c.content.length >= 50)).toBe(true);
    expect(split.some((c) => c.content.includes("adds an invoice"))).toBe(true);
  });

  it("emits no setup chunk for a loose statement too short to index", async () => {
    const code = quickSpec(['describe("Ledger") {', "    var x = 1", "}"]);
    const { specNode } = await hookRun(code);

    expect(
      produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, { maxChunkSize: 1000 }),
    ).toEqual([]);
  });

  it("emits nothing for a leaf whose only example is too short to index", async () => {
    const code = quickSpec(['describe("Ledger") {', '    it("a") { expect(1).to(equal(1)) }', "}"]);
    const { specNode } = await hookRun(code);

    expect(
      produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, { maxChunkSize: 1000 }),
    ).toEqual([]);
  });

  it("passes over a statement whose call has no name and still chunks the scope around it", async () => {
    const code = quickSpec([
      'describe("Ledger") {',
      "    ({ print(1) })()",
      ...LONG_EXAMPLE.map((l) => `    ${l}`),
      "}",
    ]);
    const { specNode } = await hookRun(code);

    const produced = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 1000,
    });

    expect(produced).toHaveLength(1);
    expect(produced[0].content).toContain("adds an invoice");
  });

  it("indexes a scope that holds only loose setup statements as a setup chunk", async () => {
    const code = quickSpec([
      'describe("Ledger") {',
      "    var ledger: Ledger! = Ledger(period: .january, currency: .usd, rounding: .bankers)",
      "}",
    ]);
    const { specNode } = await hookRun(code);

    const produced = produceQuickScopeChunks(buildQuickScopeTree(specNode, code), "LedgerSpec", code, {
      maxChunkSize: 1000,
    });

    expect(produced.map((c) => c.chunkType)).toEqual(["test_setup"]);
  });
});
