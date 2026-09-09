import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatParitySummary,
  mismatchingRows,
  run,
  type ResolverParityResult,
  type ResolverParityRow,
} from "../../scripts/spikes/ruby-resolver-parity.js";

/**
 * The Ruby seam has no `codegraph-chain-tally.ts --lang ruby` (its `CHAINS`
 * holds python and java only), so this harness IS the Ruby relocation gate.
 * Two things have to hold for its verdict to mean anything: a row diff that
 * sees a SWAPPED target (a count triple cannot), and a same-tree run that
 * reports zero — otherwise `mismatches 0` proves nothing about a real BEFORE.
 */
function row(overrides: Partial<ResolverParityRow>): ResolverParityRow {
  return {
    relPath: "app/models/user.rb",
    startLine: 12,
    callText: "account.save",
    receiver: "account",
    member: "save",
    before: null,
    after: null,
    ...overrides,
  };
}

describe("ruby-resolver-parity row diff", () => {
  it("agrees when both resolvers decline the call site", () => {
    expect(mismatchingRows([row({})])).toEqual([]);
  });

  it("agrees when both name the same file and the same symbol", () => {
    const target = { targetRelPath: "app/models/account.rb", targetSymbolId: "Account#save" };
    expect(mismatchingRows([row({ before: { ...target }, after: { ...target } })])).toEqual([]);
  });

  it("reports a swapped symbol in the same file — the shape a count triple cannot see", () => {
    const mismatches = mismatchingRows([
      row({
        before: { targetRelPath: "app/models/account.rb", targetSymbolId: "Account#save" },
        after: { targetRelPath: "app/models/account.rb", targetSymbolId: "Account.save" },
      }),
    ]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.after?.targetSymbolId).toEqual("Account.save");
  });

  it("reports an edge one side emitted and the other did not", () => {
    const gained = row({ after: { targetRelPath: "app/models/account.rb", targetSymbolId: null } });
    const lost = row({ before: { targetRelPath: "app/models/account.rb", targetSymbolId: null } });
    expect(mismatchingRows([gained, lost])).toHaveLength(2);
  });
});

describe("ruby-resolver-parity summary", () => {
  it("prints the compared / mismatches / drift triple the gate reads", () => {
    const result: ResolverParityResult = {
      mismatches: [],
      compared: 41,
      drift: 0,
      beforeSameModule: false,
      files: 3,
      symbolTableOnlyFiles: 1,
      ingestIgnored: 0,
      codegraphExcluded: 0,
      parseFailures: 0,
      symbols: 9,
      dispatchSkipped: 2,
    };
    expect(formatParitySummary("/corpus", undefined, result).join("\n")).toContain(
      "compared 41 sites · mismatches 0 · drift 0",
    );
  });

  it("flags a non-zero drift as voiding the numbers", () => {
    const result: ResolverParityResult = {
      mismatches: [],
      compared: 41,
      drift: 3,
      beforeSameModule: false,
      files: 3,
      symbolTableOnlyFiles: 0,
      ingestIgnored: 0,
      codegraphExcluded: 0,
      parseFailures: 0,
      symbols: 9,
      dispatchSkipped: 0,
    };
    expect(formatParitySummary("/corpus", "/before", result).join("\n")).toContain("numbers void");
  });

  it("says so when both sides loaded the same module, so a zero is not read as a gate", () => {
    const result: ResolverParityResult = {
      mismatches: [],
      compared: 41,
      drift: 0,
      beforeSameModule: true,
      files: 3,
      symbolTableOnlyFiles: 0,
      ingestIgnored: 0,
      codegraphExcluded: 0,
      parseFailures: 0,
      symbols: 9,
      dispatchSkipped: 0,
    };
    expect(formatParitySummary("/corpus", "/before", result).join("\n")).toContain("identity check only");
  });
});

describe("ruby-resolver-parity same-tree run", () => {
  let corpus: string;
  let result: ResolverParityResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "ruby-parity-corpus-"));
    write("app/models/account.rb", "class Account\n  def save\n    true\n  end\nend\n");
    write(
      "app/services/publisher.rb",
      "class Publisher\n  def call\n    account = Account.new\n    account.save\n  end\nend\n",
    );
    write("app/bridge.py", "def bridge():\n    return 2\n");
    result = await run(corpus, undefined, Number.MAX_SAFE_INTEGER, true);
  }, 60_000);

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("compares every Ruby call site and finds no disagreement against itself", () => {
    expect(result.compared).toBeGreaterThan(0);
    expect(result.mismatches).toEqual([]);
  });

  it("keeps the directly-constructed resolver in lockstep with the factory's", () => {
    expect(result.drift).toEqual(0);
  });

  it("marks the run as an identity check when no other checkout supplied the BEFORE side", () => {
    expect(result.beforeSameModule).toBe(true);
  });

  it("walks another language into the symbol table without scoring its call sites", () => {
    expect(result.files).toEqual(2);
    expect(result.symbolTableOnlyFiles).toEqual(1);
  });
});
