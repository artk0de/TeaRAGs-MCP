/**
 * Pass 1 on a file from disk and the in-memory extraction of the same text must
 * produce the same `FileExtraction` (bd tea-rags-mcp-raohg): both delegate to
 * `extractCodeFileFromText`, and differ only in how they read the text and load
 * the grammar.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import ignore from "ignore";
import { afterAll, describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphFileExtractor } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { extractFileInMemory } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/in-memory-extraction.js";
import { CodegraphPhaseTimings } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/phase-timings.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const FIXTURES: Record<string, string> = {
  "src/ledger/poster.ts": [
    'import { Receipt } from "./receipt";',
    "",
    "export class LedgerPoster {",
    "  post(entry: LedgerEntry, retries: number): Receipt {",
    "    const receipt = new Receipt(entry);",
    "    this.audit(receipt);",
    "    return receipt;",
    "  }",
    "  private audit(receipt: Receipt): void {",
    "    console.log(receipt);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "billing/invoice.py": [
    "from billing.money import Money",
    "",
    "class Invoice:",
    "    def __init__(self, total: Money):",
    "        self.total = total",
    "",
    "    def settle(self, payer):",
    "        receipt = payer.pay(self.total)",
    "        return receipt",
    "",
    "def issue(total):",
    "    return Invoice(total).settle(None)",
    "",
  ].join("\n"),
  "billing/data_table.py": ['CODES = {"AD": "Andorra", "AE": "United Arab Emirates"}', ""].join("\n"),
  "app/models/account.rb": [
    "module Billing",
    "  class Account < ApplicationRecord",
    "    has_many :invoices",
    "    attr_accessor :balance, :owner",
    "",
    "    def settle(invoice)",
    "      invoice.pay(balance)",
    "      notify",
    "    end",
    "",
    "    private",
    "",
    "    def notify",
    "      Mailer.deliver(owner)",
    "    end",
    "  end",
    "end",
    "",
  ].join("\n"),
};

describe("CodegraphFileExtractor#parse and extractFileInMemory — one extraction core", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-extraction-parity-"));
  for (const [relPath, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), text);
  }

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const languageFactory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const extractor = new CodegraphFileExtractor({
    languageFactory,
    collectSymbols,
    composer,
    runState: new CodegraphRunState(),
    phaseTimings: new CodegraphPhaseTimings(),
    exclusionFilter: ignore(),
  });

  it.each(Object.keys(FIXTURES))("extracts %s identically from disk and from text", async (relPath) => {
    const fromDisk = await extractor.parse(root, relPath);
    const fromText = extractFileInMemory({ languageFactory, collectSymbols, composer }, relPath, FIXTURES[relPath]);

    // The data table takes the inert fast path; every other fixture yields symbols.
    expect(fromDisk.chunks.length > 0).toBe(!relPath.endsWith("data_table.py"));
    expect(fromText).toEqual(fromDisk);
  });
});
