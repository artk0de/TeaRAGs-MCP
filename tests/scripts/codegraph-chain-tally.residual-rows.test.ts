import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseArgs, run, type RunResult } from "../../scripts/codegraph-chain-tally.js";

/**
 * `--residual-rows` (bd tea-rags-mcp-s3i8m.1): the residual taxonomy needs EVERY
 * call site the runner left unresolved while an in-project definition of its
 * member exists — the six `kindSamples` per kind are a preview, not a population.
 */
describe("codegraph-chain-tally residual rows", () => {
  let corpus: string;
  let result: RunResult;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeAll(async () => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-residual-"));
    write(
      "src/lib.rs",
      [
        "pub struct Stack { items: Vec<u8> }",
        "impl Stack {",
        "    pub fn push(&mut self, item: u8) { self.items.push(item); }",
        "}",
        "pub fn fill<T>(target: T) {",
        "    target.push(1);",
        "}",
        "pub fn helper() {}",
        "pub fn caller() { helper(); }",
        "",
      ].join("\n"),
    );
    result = await run(corpus, "rust", null, Number.MAX_SAFE_INTEGER, true, true, {
      timeOnly: true,
      residualRows: true,
    });
  }, 60_000);

  afterAll(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("emits a row for a site missed while the member has an in-project definition", () => {
    expect(result.residualRows ?? []).toContainEqual(
      expect.objectContaining({
        relPath: "src/lib.rs",
        startLine: 6,
        receiver: "target",
        member: "push",
        missBucket: "missWithInProjectDef",
      }),
    );
  });

  it("carries the receiver kind and the 0-based column the walker recorded", () => {
    const row = (result.residualRows ?? []).find((r) => r.startLine === 6);
    expect(row?.receiverKind).toEqual(expect.any(String));
    expect(row?.startColumn).toBe(4);
  });

  it("never emits a resolved site", () => {
    expect((result.residualRows ?? []).some((r) => r.member === "helper")).toBe(false);
  });

  it("leaves the field absent when the option is off", async () => {
    const off = await run(corpus, "rust", null, Number.MAX_SAFE_INTEGER, true, true, { timeOnly: true });
    expect(off.residualRows).toBeUndefined();
  });

  it("parses --residual-rows <path> into the option", () => {
    expect(parseArgs(["--residual-rows", "/tmp/r.ndjson"]).residualRows).toBe("/tmp/r.ndjson");
    expect(parseArgs([]).residualRows).toBeNull();
  });
});
