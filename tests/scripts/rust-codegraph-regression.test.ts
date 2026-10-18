import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const tempRoot = process.env.TEA_RAGS_DATA_DIR;
if (!tempRoot) throw new Error("test setup must provide TEA_RAGS_DATA_DIR");
mkdirSync(tempRoot, { recursive: true });

// A new module starts as an empty surface, so RED reports missing behavior,
// rather than a loader failure. No replacement implementation lives in tests.
const moduleUrl = new URL("../../scripts/lib/rust-codegraph-regression.ts", import.meta.url);
const sut = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};

function artifact(rows: unknown[] = []) {
  return {
    schemaVersion: 1,
    corpus: {
      alias: "ripgrep-rust",
      commit: "a".repeat(40),
      config: "production-default",
      options: { timeOnly: true, kindStats: true, persisted: true, edgeDump: true },
    },
    engine: { commit: "b".repeat(40), dirty: false },
    workload: { files: 1, sites: 1, symbols: 2, loc: 10, siteDigest: "c".repeat(64), dispatch: true },
    environment: {
      node: "v24",
      platform: "darwin",
      arch: "arm64",
      cpuModel: "fixture",
      cpuCount: 10,
      nodeOptions: "",
      resolverEnv: {},
      loadMonitoring: { status: "sampled", samples: 3, maxLoadPerCpu: 0.2 },
      loadPerCpu: 0.2,
    },
    identityScheme: "tally-line-callText-startColumn-v1",
    measurementScope: "fresh-extraction-and-production-resolver",
    chainDrift: { status: "not-run", reason: "time-only production runner" },
    oracle: { status: "not-run", reason: "independent Rust oracle pending" },
    timing: { pass1Ms: 100, pass2Ms: 100, totalMs: 200, peakRssMb: 50 },
    rows,
  };
}

const edge = (kind = "runner:exact", symbol = "A::run") => ({
  relPath: "src/main.rs",
  line: 1,
  callText: "a.run()",
  receiverKind: "typed",
  targetRelPath: "src/a.rs",
  targetSymbolId: symbol,
  edgeKind: kind,
});

function compare(before: unknown, after: unknown, policy: unknown = {}) {
  expect(sut.compareRustCodegraphArtifacts, "baseline/after regression comparison exists").toBeTypeOf("function");
  return sut.compareRustCodegraphArtifacts(before, after, policy);
}

describe("Rust codegraph baseline/after gate", () => {
  it("does not turn absent oracle or time-only zero drift into verification", () => {
    const result = compare(artifact([edge()]), artifact([edge()]));
    expect(result.oracle.after).toMatchObject({
      status: "not-run",
      exactRecall: null,
      candidateRecall: null,
      exactPrecision: null,
    });
    expect(result.chainDrift.after.status).toBe("not-run");
    expect(result.extractionCoverage).toBeNull();
    expect(result.failures).toEqual([]);
  });

  it("separates exact loss from candidate gain even for the same target", () => {
    const before = artifact([edge()]);
    const result = compare(before, artifact([edge("runner:cone@0.5")]), {
      adjudications: [{ edge: edge(), verdict: "valid", reason: "independent manual source check" }],
      maxValidEdgeLoss: 0,
    });
    expect(result.edges.exact.lost).toHaveLength(1);
    expect(result.edges.candidate.gained).toHaveLength(1);
    expect(result.failures).toContain("valid-edge-loss:1>0");
    expect(result.exitCode).toBe(1);
  });

  it("does not freeze incorrect old edges and fails known false additions", () => {
    const result = compare(artifact([edge()]), artifact([edge("runner:exact", "A::wrong")]), {
      adjudications: [
        { edge: edge(), verdict: "incorrect", reason: "old false positive" },
        { edge: edge("runner:exact", "A::wrong"), verdict: "incorrect", reason: "wrong overload" },
      ],
      maxValidEdgeLoss: 0,
      maxFalseEdgeGain: 0,
    });
    expect(result.edges.exact.lost).toHaveLength(1);
    expect(result.validEdgeLoss).toBe(0);
    expect(result.failures).toContain("false-edge-gain:1>0");
  });

  it("fails comparable cost regressions and refuses mismatched workload cost claims", () => {
    const before = artifact();
    const after = structuredClone(before);
    after.timing.pass2Ms = 130;
    after.timing.totalMs = 230;
    expect(compare(before, after, { maxCostRatio: { pass2Ms: 1.2 } }).failures).toContain("cost-regression:pass2Ms");
    after.workload.siteDigest = "d".repeat(64);
    const result = compare(before, after, { maxCostRatio: { pass2Ms: 1.2 } });
    expect(result.cost.status).toBe("incomparable");
    expect(result.failures).toContain("cost-unmeasured:incomparable-workload");
  });

  it("rejects malformed numbers, unsupported provenance, and wrong corpus pins", () => {
    const invalid = artifact();
    invalid.timing.pass2Ms = Number.NaN;
    expect(() => compare(invalid, artifact())).toThrow();
    expect(() => compare(artifact([edge("runner:invented")]), artifact())).toThrow();
    const other = artifact();
    other.corpus.commit = "f".repeat(40);
    expect(() => compare(artifact(), other)).toThrow(/corpus/);
  });

  it("scores only independently ingested complete target sets and keeps unknown buckets out of rates", () => {
    const after: Record<string, unknown> = artifact([edge(), edge("runner:cone@0.5", "A::other")]);
    after.oracle = {
      status: "ingested",
      source: "fixture-independent-oracle",
      identityScheme: "tally-line-callText-startColumn-v1",
      sites: [
        {
          relPath: "src/main.rs",
          line: 1,
          callText: "a.run()",
          classification: "inProject",
          expected: [{ targetRelPath: "src/a.rs", targetSymbolId: "A::run" }],
        },
        { relPath: "src/main.rs", line: 2, callText: "opaque()", classification: "unknown", expected: [] },
        { relPath: "src/main.rs", line: 3, callText: "external()", classification: "external", expected: [] },
        { relPath: "src/main.rs", line: 4, callText: "generated()", classification: "generated", expected: [] },
        { relPath: "src/main.rs", line: 5, callText: "inactive()", classification: "inactive-cfg", expected: [] },
      ],
    };
    const result = compare(artifact(), after);
    expect(result.oracle.after).toMatchObject({
      status: "ingested",
      exactRecall: 1,
      candidateRecall: 0,
      exactPrecision: 1,
      candidatePrecision: 0,
      expectedTargets: 1,
      classifiedSites: 5,
    });
    expect(result.oracle.after.buckets).toEqual({
      inProject: 1,
      external: 1,
      unknown: 1,
      generated: 1,
      "inactive-cfg": 1,
    });
  });

  it("retains TSV mapping and ignores answer rows when diffing persisted predictions", () => {
    expect(sut.parseRustTallyDump).toBeTypeOf("function");
    const rows = sut.parseRustTallyDump(
      "src/main.rs\t1\ta.run()\t-\ttyped\tsrc/a.rs\tA::run\texact\nsrc/main.rs\t1\ta.run()\t-\ttyped\tsrc/a.rs\tA::run\trunner:exact@1\n#kind-stats\nopaque stats\n",
    );
    expect(rows).toHaveLength(2);
    expect(compare(artifact(rows), artifact()).edges.exact.lost).toHaveLength(1);
  });

  it("supports portable corpus overrides and refuses an unpinned corpus selection", async () => {
    const entryUrl = new URL("../../scripts/rust-codegraph-regression.ts", import.meta.url);
    const cli = existsSync(entryUrl) ? await import(entryUrl.href) : {};
    expect(cli.selectRustCorpus).toBeTypeOf("function");
    const selected = cli.selectRustCorpus("ripgrep-rust", "/portable/ripgrep");
    expect(selected.root).toBe("/portable/ripgrep");
    expect(selected.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(selected.options).toEqual({ timeOnly: true, kindStats: true, persisted: true, edgeDump: true });
    expect(() => cli.selectRustCorpus("unknown")).toThrow(/unknown corpus/);
  });

  it("captures artifacts by invoking the existing production tally, not another resolver", async () => {
    const entryUrl = new URL("../../scripts/rust-codegraph-regression.ts", import.meta.url);
    const cli = existsSync(entryUrl) ? await import(entryUrl.href) : {};
    expect(cli.captureRustCodegraphArtifact).toBeTypeOf("function");
    const calls: unknown[][] = [];
    const result = await cli.captureRustCodegraphArtifact(
      cli.selectRustCorpus("ripgrep-rust", "/fixture"),
      { commit: "b".repeat(40), dirty: false },
      async (...args: unknown[]) => {
        calls.push(args);
        return {
          rows: [{ relPath: "src/main.rs", startLine: 1, callText: "a.run()" }],
          files: 1,
          symbols: 2,
          timeOnly: true,
          chainDrift: 0,
          parseFailures: 0,
          symbolTableOnlyFiles: 0,
          ingestIgnored: 0,
          codegraphExcluded: 0,
          timing: { pass1Ms: 100, pass2Ms: 100, totalMs: 200, peakRssMb: 50, loc: 10 },
          edgeDump: [edge()],
          kindStats: {},
        };
      },
    );
    expect(calls[0]).toEqual([
      "/fixture",
      "rust",
      null,
      Infinity,
      true,
      true,
      { timeOnly: true, kindStats: true, persisted: true, edgeDump: true },
    ]);
    expect(result.chainDrift.status).toBe("not-run");
    expect(result.oracle.status).toBe("not-run");
    expect(result.rows).toEqual([edge()]);
    expect(result.workload.siteDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keys same-line duplicate calls apart by their start column", () => {
    expect(sut.rustTallySiteKey, "site key exists").toBeTypeOf("function");
    const first = sut.rustTallySiteKey({ relPath: "a.rs", line: 2, callText: "ping()", startColumn: 4 });
    const second = sut.rustTallySiteKey({ relPath: "a.rs", line: 2, callText: "ping()", startColumn: 12 });
    expect(first).not.toBe(second);
    expect(sut.rustTallySiteKey({ relPath: "a.rs", line: 2, callText: "ping()" })).toBe(
      sut.rustTallySiteKey({ relPath: "a.rs", line: 2, callText: "ping()", startColumn: undefined }),
    );
  });

  it("keeps same-line duplicate sites and fan-out sites truthful in capture", async () => {
    const entryUrl = new URL("../../scripts/rust-codegraph-regression.ts", import.meta.url);
    const cli = await import(entryUrl.href);
    const row = (startColumn?: number) => ({ relPath: "src/main.rs", startLine: 5, callText: "ping()", startColumn });
    const dump = (startColumn: number, symbol: string) => ({
      relPath: "src/main.rs",
      line: 5,
      callText: "ping()",
      startColumn,
      receiverKind: "typed",
      targetRelPath: "src/a.rs",
      targetSymbolId: symbol,
      edgeKind: "runner:exact",
    });
    const result = await cli.captureRustCodegraphArtifact(
      cli.selectRustCorpus("ripgrep-rust", "/fixture"),
      { commit: "b".repeat(40), dirty: false },
      async () => ({
        rows: [row(4), row(12)],
        files: 1,
        symbols: 2,
        timeOnly: true,
        chainDrift: 0,
        parseFailures: 0,
        symbolTableOnlyFiles: 0,
        ingestIgnored: 0,
        codegraphExcluded: 0,
        timing: { pass1Ms: 100, pass2Ms: 100, totalMs: 200, peakRssMb: 50, loc: 10 },
        edgeDump: [dump(4, "A::ping"), dump(12, "A::ping"), dump(4, "B::ping")],
        kindStats: {},
      }),
    );
    expect(result.rows).toHaveLength(3);
  });

  it("refuses a capture whose edge dump carries a site the tally rows never saw", async () => {
    const entryUrl = new URL("../../scripts/rust-codegraph-regression.ts", import.meta.url);
    const cli = await import(entryUrl.href);
    await expect(
      cli.captureRustCodegraphArtifact(
        cli.selectRustCorpus("ripgrep-rust", "/fixture"),
        { commit: "b".repeat(40), dirty: false },
        async () => ({
          rows: [{ relPath: "src/main.rs", startLine: 5, callText: "ping()", startColumn: 4 }],
          files: 1,
          symbols: 2,
          timeOnly: true,
          chainDrift: 0,
          parseFailures: 0,
          symbolTableOnlyFiles: 0,
          ingestIgnored: 0,
          codegraphExcluded: 0,
          timing: { pass1Ms: 100, pass2Ms: 100, totalMs: 200, peakRssMb: 50, loc: 10 },
          edgeDump: [
            {
              relPath: "src/main.rs",
              line: 5,
              callText: "ping()",
              startColumn: 4,
              receiverKind: "typed",
              targetRelPath: "src/a.rs",
              targetSymbolId: "A::ping",
              edgeKind: "runner:exact",
            },
            {
              relPath: "src/main.rs",
              line: 9,
              callText: "orphan()",
              startColumn: 0,
              receiverKind: "typed",
              targetRelPath: "src/a.rs",
              targetSymbolId: "A::orphan",
              edgeKind: "runner:exact",
            },
          ],
          kindStats: {},
        }),
      ),
    ).rejects.toThrow(/site identity/);
  });

  it("refuses silent truth gaps when a valid-loss gate is configured", () => {
    const result = compare(artifact([edge()]), artifact(), { maxValidEdgeLoss: 0 });
    expect(result.failures).toContain("valid-edge-loss-unmeasured:1");
    expect(result.exitCode).toBe(1);
  });

  it("refuses silent false-positive gaps when a precision gate is configured", () => {
    const result = compare(artifact(), artifact([edge()]), { maxFalseEdgeGain: 0 });
    expect(result.failures).toContain("false-edge-gain-unmeasured:1");
  });

  it("does not let an adjudication contradict independent oracle truth silently", () => {
    const before: Record<string, unknown> = artifact([edge()]);
    before.oracle = {
      status: "ingested",
      source: "independent",
      identityScheme: "tally-line-callText-startColumn-v1",
      sites: [
        {
          relPath: "src/main.rs",
          line: 1,
          callText: "a.run()",
          classification: "inProject",
          expected: [{ targetRelPath: "src/a.rs", targetSymbolId: "A::run" }],
        },
      ],
    };
    expect(() =>
      compare(before, artifact(), { adjudications: [{ edge: edge(), verdict: "incorrect", reason: "contradiction" }] }),
    ).toThrow(/contradict/);
  });

  it("writes artifact-only CLI reports and returns a failing gate exit code", async () => {
    const cli = await import("../../scripts/rust-codegraph-regression.js");
    const dir = mkdtempSync(join(tempRoot, "rust-gate-"));
    try {
      const before = join(dir, "before.json");
      const after = join(dir, "after.json");
      const policy = join(dir, "policy.json");
      const out = join(dir, "diff.json");
      writeFileSync(before, JSON.stringify(artifact([edge()])));
      writeFileSync(after, JSON.stringify(artifact()));
      writeFileSync(
        policy,
        JSON.stringify({
          maxValidEdgeLoss: 0,
          adjudications: [{ edge: edge(), verdict: "valid", reason: "fixture truth" }],
        }),
      );
      expect(
        await cli.rustCodegraphRegressionMain([
          "compare",
          "--before",
          before,
          "--after",
          after,
          "--policy",
          policy,
          "--out",
          out,
        ]),
      ).toBe(1);
      expect(JSON.parse(readFileSync(out, "utf8")).failures).toContain("valid-edge-loss:1>0");
      await expect(cli.rustCodegraphRegressionMain(["compare", "--unknown", "x"])).rejects.toThrow(/invalid option/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps receiver counters with their denominator contract, not a recall label", () => {
    const before = { ...artifact(), kindStats: { typed: { eligible: 2, resolved: 1 } } };
    const after = { ...artifact(), kindStats: { typed: { eligible: 3, resolved: 2 } } };
    expect(compare(before, after).receiverKindStats).toEqual({
      before: before.kindStats,
      after: after.kindStats,
      denominatorContract: "production tallyCallSiteVerdict counters; resolveSuccessRate is not target recall",
    });
  });

  it("rejects empty capture and rechecks pins after extraction", async () => {
    const cli = await import("../../scripts/rust-codegraph-regression.js");
    const corpus = cli.selectRustCorpus("ripgrep-rust", "/fixture");
    const engine = { commit: "b".repeat(40), dirty: false };
    const result = {
      rows: [{ relPath: "src/main.rs", startLine: 1, callText: "a.run()" }],
      files: 1,
      symbols: 2,
      timeOnly: true,
      parseFailures: 0,
      timing: { pass1Ms: 1, pass2Ms: 1, totalMs: 2, peakRssMb: 10, loc: 2 },
      edgeDump: [edge()],
      kindStats: {},
    };
    await expect(
      cli.captureRustCodegraphArtifact(
        corpus,
        engine,
        async () => ({ ...result, files: 0, rows: [], edgeDump: [] }) as never,
      ),
    ).rejects.toThrow(/empty/);
    let reads = 0;
    await expect(
      cli.captureRustCodegraphArtifact(corpus, engine, async () => result as never, {
        readPin: () => ({ corpus: { commit: corpus.commit, dirty: ++reads > 1 }, engine }),
      }),
    ).rejects.toThrow(/pin|clean|changed/);
    expect(reads).toBe(2);
  });

  it("records effective knobs and admits insufficient load observation instead of isolated timing", async () => {
    const cli = await import("../../scripts/rust-codegraph-regression.js");
    const corpus = cli.selectRustCorpus("ripgrep-rust", "/fixture");
    const captured = await cli.captureRustCodegraphArtifact(
      corpus,
      { commit: "b".repeat(40), dirty: false },
      async () =>
        ({
          rows: [{ relPath: "src/main.rs", startLine: 1, callText: "a.run()" }],
          files: 1,
          symbols: 2,
          timeOnly: true,
          parseFailures: 0,
          timing: { pass1Ms: 1, pass2Ms: 1, totalMs: 2, peakRssMb: 10, loc: 2 },
          edgeDump: [edge()],
          kindStats: {},
        }) as never,
    );
    expect(captured.corpus).toMatchObject({ options: corpus.options });
    expect(captured.environment).toMatchObject({
      resolverEnv: expect.any(Object),
      loadMonitoring: { status: "insufficient" },
    });
    expect(compare(captured, captured).cost.status).toBe("incomparable");
  });

  it("rechecks engine and corpus pin changes even after a nonempty run", async () => {
    const cli = await import("../../scripts/rust-codegraph-regression.js");
    const corpus = cli.selectRustCorpus("ripgrep-rust", "/fixture");
    const engine = { commit: "b".repeat(40), dirty: false };
    for (const mutation of ["corpus-dirty", "corpus-head", "engine-dirty", "engine-head"]) {
      let reads = 0;
      await expect(
        cli.captureRustCodegraphArtifact(
          corpus,
          engine,
          async () =>
            ({
              rows: [{ relPath: "src/main.rs", startLine: 1, callText: "a.run()" }],
              files: 1,
              symbols: 2,
              timeOnly: true,
              parseFailures: 0,
              timing: { pass1Ms: 1, pass2Ms: 1, totalMs: 2, peakRssMb: 10, loc: 2 },
              edgeDump: [edge()],
              kindStats: {},
            }) as never,
          {
            readPin: () => {
              const changed = ++reads > 1;
              return {
                corpus: {
                  commit: changed && mutation === "corpus-head" ? "f".repeat(40) : corpus.commit,
                  dirty: changed && mutation === "corpus-dirty",
                },
                engine: {
                  commit: changed && mutation === "engine-head" ? "f".repeat(40) : engine.commit,
                  dirty: changed && mutation === "engine-dirty",
                },
              };
            },
          },
        ),
      ).rejects.toThrow(/pin|clean|changed/);
      expect(reads).toBe(2);
    }
  });

  it("does not compare cost with different effective options or resolver environment", () => {
    const before = artifact();
    const optionsChanged = structuredClone(before);
    optionsChanged.corpus.options.persisted = false;
    const envChanged = {
      ...structuredClone(before),
      environment: { ...before.environment, resolverEnv: { CODEGRAPH_RUST_TEST: "1" } },
    };
    expect(compare(before, optionsChanged, { maxCostRatio: { totalMs: 2 } }).cost.status).toBe("incomparable");
    expect(compare(before, envChanged, { maxCostRatio: { totalMs: 2 } }).cost.status).toBe("incomparable");
  });

  it("rejects duplicate predictions before provenance can collapse", () => {
    for (const rows of [
      [edge(), edge()],
      [edge("runner:cone@0.5"), edge("runner:registry@0.5")],
    ]) {
      expect(() => compare(artifact(rows), artifact())).toThrow(/duplicate.*prediction/);
      expect(() => compare(artifact(), artifact([...rows].reverse()))).toThrow(/duplicate.*prediction/);
    }
  });

  it("rejects contradictory or differently sourced oracle truth and shares improved known truth", () => {
    const oracle = (classification = "inProject", source = "independent") => ({
      status: "ingested",
      source,
      identityScheme: "tally-line-callText-startColumn-v1",
      sites: [
        {
          relPath: "src/main.rs",
          line: 1,
          callText: "a.run()",
          classification,
          expected: classification === "inProject" ? [{ targetRelPath: "src/a.rs", targetSymbolId: "A::run" }] : [],
        },
      ],
    });
    const before = { ...artifact([edge()]), oracle: oracle() };
    expect(() => compare(before, { ...artifact(), oracle: oracle("external") })).toThrow(/contradict|incomparable/);
    expect(() => compare(before, { ...artifact(), oracle: oracle("inactive-cfg") })).toThrow(/contradict|incomparable/);
    const changedTarget = oracle();
    changedTarget.sites[0].expected[0].targetSymbolId = "A::different";
    expect(() => compare(before, { ...artifact(), oracle: changedTarget })).toThrow(/contradict|incomparable/);
    expect(() => compare(before, { ...artifact(), oracle: oracle("inProject", "other") })).toThrow(
      /source|incomparable/,
    );
    const duplicate = oracle();
    duplicate.sites.push(duplicate.sites[0]);
    expect(() => compare({ ...artifact(), oracle: duplicate }, artifact())).toThrow(/duplicate oracle/);
    const result = compare(
      { ...before, oracle: oracle("unknown") },
      { ...artifact(), oracle: oracle() },
      { maxValidEdgeLoss: 0 },
    );
    expect(result.validEdgeLoss).toBe(1);
    expect(result.oracleComparison).toMatchObject({ source: "independent", truth: "merged-known-sites" });
  });

  it("requires an enforcing CLI policy unless report-only is explicit", async () => {
    const cli = await import("../../scripts/rust-codegraph-regression.js");
    const dir = mkdtempSync(join(tempRoot, "rust-report-"));
    try {
      const before = join(dir, "before.json"),
        after = join(dir, "after.json"),
        out = join(dir, "out.json");
      writeFileSync(before, JSON.stringify(artifact([edge()])));
      writeFileSync(after, JSON.stringify(artifact()));
      const args = ["compare", "--before", before, "--after", after, "--out", out];
      await expect(cli.rustCodegraphRegressionMain(args)).rejects.toThrow(/policy|report-only/);
      expect(existsSync(out)).toBe(false);
      expect(await cli.rustCodegraphRegressionMain([...args, "--report-only"])).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).gate).toMatchObject({ status: "report-only", enforced: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects zero confidence and keeps non-exact provenance changes visible", () => {
    expect(() => compare(artifact([edge("runner:cone@0")]), artifact())).toThrow();
    const result = compare(artifact([edge("runner:cone@0.5")]), artifact([edge("runner:registry@0.5")]));
    expect(result.edges.candidate.provenanceChanged).toHaveLength(1);
  });
});
