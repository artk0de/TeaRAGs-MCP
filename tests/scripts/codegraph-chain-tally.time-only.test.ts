import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  formatKindStatsBlock,
  formatTimingBlock,
  parseArgs,
  run,
  scoredExtensionsFor,
  type ChainTallyTiming,
} from "../../scripts/codegraph-chain-tally.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
} from "../../scripts/ts-codegraph-typechecker-oracle.js";
import type { FileExtraction } from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { collectSchemaColumnSources } from "../../src/core/domains/trajectory/codegraph/exclusion.js";
import { absorbPass1FileState } from "../../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import type { ReceiverKind } from "../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import {
  CodegraphRunState,
  emptyReceiverKindTally,
  languageKindTally,
  type ReceiverKindTally,
} from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectDependencyManifestSources } from "../../src/core/infra/dependency-manifests.js";

/**
 * The scored set is inverted out of the engine's own extension→language map
 * rather than hand-listed per leg. `.tsx` is the reason: a hand-list that
 * forgets it scores half a TypeScript corpus and still reports a wall as if it
 * had walked all of it (bd E6.0a).
 */
describe("scoredExtensionsFor", () => {
  it("gives TypeScript both grammars and the ESM/CJS module extensions (bd 1y13c)", () => {
    expect([...scoredExtensionsFor("typescript")].sort()).toEqual([".cts", ".mts", ".ts", ".tsx"]);
  });

  it("gives Ruby and Python their single extension", () => {
    expect(scoredExtensionsFor("ruby")).toEqual([".rb"]);
    expect(scoredExtensionsFor("python")).toEqual([".py"]);
  });

  it("agrees with the hand-written CHAINS entries it replaces", () => {
    expect(scoredExtensionsFor("python")).toEqual([".py"]);
    expect(scoredExtensionsFor("java")).toEqual([".java"]);
  });

  it("keeps the JavaScript grammars out of the TypeScript leg, as the registry does", () => {
    expect([...scoredExtensionsFor("javascript")].sort()).toContain(".jsx");
    expect(scoredExtensionsFor("typescript")).not.toContain(".js");
  });

  it("throws rather than scoring nothing for an unwalked language", () => {
    expect(() => scoredExtensionsFor("cobol")).toThrow(/cobol/);
  });
});

describe("parseArgs timing flags", () => {
  it("makes --time-only imply --timing, since the numbers are its whole point", () => {
    const opts = parseArgs(["--time-only"]);
    expect(opts.timeOnly).toBe(true);
    expect(opts.timing).toBe(true);
  });

  it("keeps --timing usable on its own, so a --defer run can also be timed", () => {
    const opts = parseArgs(["--defer", "globalShortName", "--timing"]);
    expect(opts.timeOnly).toBe(false);
    expect(opts.timing).toBe(true);
  });

  it("leaves both off by default, so the existing python/java runs are unchanged", () => {
    const opts = parseArgs(["--lang", "python"]);
    expect(opts.timeOnly).toBe(false);
    expect(opts.timing).toBe(false);
  });

  it("reads --ts-checker=off as the kill switch and defaults it on", () => {
    expect(parseArgs(["--ts-checker=off"]).tsChecker).toBe(false);
    expect(parseArgs([]).tsChecker).toBe(true);
  });
});

/**
 * The normalized columns are the verdict E6.0b takes, so their arithmetic is
 * gated here rather than eyeballed off a run: a per-1k divisor applied to the
 * wrong unit turns a 2× regression into a pass.
 */
describe("formatTimingBlock", () => {
  const timing: ChainTallyTiming = {
    pass1Ms: 4_000,
    pass2Ms: 6_000,
    totalMs: 10_000,
    peakRssMb: 800,
    loc: 200_000,
  };

  it("normalizes per 1k sites, per 10k LOC and per 1k files off one 10 s run", () => {
    const lines = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    // 10 s / 20k sites = 0.500 s per 1k sites, and its inverse, 2000 sites/s.
    expect(lines).toContain("0.500 s/1k sites");
    expect(lines).toContain("2000 sites/s");
    // 10 s / 200k LOC = 0.500 s per 10k LOC; 800 MB / 2k files = 400 MB per 1k.
    expect(lines).toContain("0.500 s/10k LOC");
    expect(lines).toContain("400 MB/1k files");
  });

  it("reports seconds and MB, not the ms and bytes it is fed", () => {
    const lines = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    expect(lines).toContain("pass1 4.00s · pass2 6.00s · total 10.00s · peak RSS 800 MB");
    expect(lines).toContain("2000 scored files · 20000 sites · 200000 LOC");
  });

  it("says the drift check did not run, so a --time-only block never reads as verified", () => {
    const quiet = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: false }).join("\n");
    expect(quiet).not.toContain("--time-only");
    const timed = formatTimingBlock(timing, { files: 2_000, sites: 20_000, timeOnly: true }).join("\n");
    expect(timed).toContain("chain-drift check NOT run");
  });

  it("prints no division by zero for a corpus with no scored file", () => {
    const empty: ChainTallyTiming = { pass1Ms: 12, pass2Ms: 0, totalMs: 12, peakRssMb: 90, loc: 0 };
    const lines = formatTimingBlock(empty, { files: 0, sites: 0, timeOnly: true }).join("\n");
    expect(lines).not.toMatch(/NaN|Infinity/);
  });
});

/**
 * bd tea-rags-mcp-qodqg — a kind whose every site is `noInProjectDef` has an
 * empty denominator. It rendered `1.000 0/0`, the same column a kind that
 * resolved everything reads; the owner decision is a non-numeric marker with
 * the counters kept, for both the per-kind rows and TOTAL.
 */
describe("formatKindStatsBlock — empty denominator", () => {
  it("renders an all-noInProjectDef kind and an empty TOTAL as the marker, not 1.000", () => {
    const stats = emptyReceiverKindTally();
    stats.index = { ...stats.index, attempted: 6, noInProjectDef: 6 };
    const lines = formatKindStatsBlock(stats, undefined);
    const indexRow = lines.find((l) => l.trimStart().startsWith("index "));
    const totalRow = lines.find((l) => l.trimStart().startsWith("TOTAL"));
    expect(indexRow).toContain("—  0/0");
    expect(indexRow).not.toContain("1.000");
    expect(totalRow).toContain("—  0/0");
    expect(totalRow).not.toContain("1.000");
  });

  it("keeps a numeric rate for a kind that scored something, even at 0", () => {
    const stats = emptyReceiverKindTally();
    stats.index = { ...stats.index, attempted: 3 };
    const lines = formatKindStatsBlock(stats, undefined).join("\n");
    expect(lines).toContain("0.000 0/3");
    expect(lines).not.toContain("—");
  });
});

/**
 * What production books for `lang` over `corpus`: its method edges and its
 * per-kind counters. The provider's pass-1 seam and pass-2 runner — the
 * extraction sink's `absorbPass1FileState` per walked file, `seal` at the
 * barrier, `CallEdgeResolutionRunner#resolve` per file of `lang`.
 */
async function productionRun(
  corpus: string,
  lang: string,
): Promise<{
  answers: string[];
  /** Every method edge WITH its source, so a callee-sourced join edge is told apart. */
  sourcedAnswers: string[];
  kinds: Record<ReceiverKind, ReceiverKindTally>;
}> {
  const factory = new LanguageFactory({ repoRoot: corpus });
  const composer = new DefaultSymbolIdComposer();
  const state = new CodegraphRunState(collectSchemaColumnSources(factory), collectDependencyManifestSources(factory));
  state.bindProjectRoot(corpus);
  state.loadDeclaredDependencies(corpus);
  state.loadSchemaSnapshots(corpus);
  const table = new InMemoryGlobalSymbolTable();
  const selection = await collectSourceFiles(
    corpus,
    corpus,
    await buildCorpusExclusionFilter(corpus, factory),
    Object.keys(CODEGRAPH_LANGUAGES),
  );
  const extractions: FileExtraction[] = [];
  for (const relPath of selection.kept) {
    const extraction = extractFile(corpus, relPath, composer, factory, state.declaredDependencies);
    if (extraction === null) continue;
    absorbPass1FileState(state, table, extraction, buildSymbolDefs(extraction), "own");
    extractions.push(extraction);
  }
  await state.seal(async () => table);
  const runner = new CallEdgeResolutionRunner(factory, state);
  runner.prepareResolvePass();
  const answers: string[] = [];
  const sourcedAnswers: string[] = [];
  for (const extraction of extractions) {
    if (extraction.language !== lang) continue;
    for (const edge of runner.resolve(extraction, table).methodEdges) {
      answers.push(`${extraction.relPath} ${edge.callExpression} -> ${edge.targetRelPath}#${edge.targetSymbolId}`);
      sourcedAnswers.push(
        `${extraction.relPath} ${edge.callExpression} ${edge.sourceSymbolId} -> ${edge.targetRelPath}#${edge.targetSymbolId}`,
      );
    }
  }
  return {
    answers: answers.sort(),
    sourcedAnswers: sourcedAnswers.sort(),
    kinds: languageKindTally(state.stats, lang),
  };
}

/**
 * bd tea-rags-mcp-pkfi7 — the harness must resolve a polyglot corpus exactly as
 * the production runner does. Production partitions the run-global class-name
 * maps, the return-type maps and the CHA hierarchy by language FAMILY (bd
 * nbf8q / qea83); a harness that merges them into one record lets a TypeScript
 * `Error` subclass join a Ruby `Error`'s cone and a Go method `get` type a Ruby
 * `get`, so `--time-only --kind-stats` stops measuring what a live run books.
 *
 * The reference side is the provider's pass-1 seam and pass-2 runner: the
 * extraction sink's `absorbPass1FileState` per walked file, `seal` at the
 * barrier, `CallEdgeResolutionRunner#resolve` per scored file. The harness must
 * agree with it per call site and per receiver-kind counter.
 *
 * `zz/repo.rb` sorts AFTER `pkg/store.go`, so a merged last-write-wins
 * `functionReturnTypes` hands the Go method `get` the Ruby `get`'s `Widget`
 * and the Go leg loses `x.Save()`. The TS / Ruby `Error` pair keeps the
 * hierarchy partition under the same parity assertion.
 */
describe("codegraph-chain-tally polyglot parity with the production runner (pkfi7)", () => {
  let corpus: string;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeAll(() => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-polyglot-"));
    write(
      "web/errors.ts",
      'export class AppError extends Error {\n  describe(): string {\n    return "app";\n  }\n}\n',
    );
    write(
      "app/errors.rb",
      [
        "class NotFound < Error",
        "  def describe",
        '    "nf"',
        "  end",
        "end",
        "",
        "class Handler",
        "  # @param err [Error]",
        "  def handle(err)",
        "    err.describe",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    write(
      "zz/repo.rb",
      [
        "class Widget",
        "  def spin",
        "    1",
        "  end",
        "end",
        "",
        "class Repo",
        "  # @return [Widget]",
        "  def get",
        "    Widget.new",
        "  end",
        "",
        "  def run",
        "    w = get",
        "    w.spin",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    write(
      "pkg/store.go",
      [
        "package pkg",
        "",
        "type Record struct{}",
        "",
        "func (r *Record) Save() {}",
        "",
        "type Store struct{}",
        "",
        "func (s *Store) get() *Record { return &Record{} }",
        "",
        "func (s *Store) use() {",
        "\tx := s.get()",
        "\tx.Save()",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it.each(["ruby", "go", "typescript"])(
    "books the same %s edges and receiver-kind counters as the production runner",
    async (lang) => {
      const harness = await run(corpus, lang, null, Number.MAX_SAFE_INTEGER, true, true, {
        timeOnly: true,
        kindStats: true,
      });
      const reference = await productionRun(corpus, lang);

      expect(harness.fanSites).toBe(0);
      const answers = harness.rows
        .filter((row) => row.runnerAnswer !== null)
        .map(
          (row) =>
            `${row.relPath} ${row.callText} -> ${row.runnerAnswer?.targetRelPath}#${row.runnerAnswer?.targetSymbolId}`,
        )
        .sort();
      expect(answers).toEqual(reference.answers);
      expect(harness.kindStats).toEqual(reference.kinds);
    },
    60_000,
  );
});

/**
 * bd tea-rags-mcp-c6xuu — the three counting paths pkfi7 left the harness
 * short of. Production resolves a dispatch-table site (`CallRef.dispatch`,
 * which the Python dict-table walker emits, bd pbwd) through `resolveDispatch`
 * and counts it in `attempted`; it replays the additive `dispatchArgs` join
 * (the callee edge PLUS the callee-sourced fan); and it counts a constant
 * receiver that lands on a shared self-dispatch entry as `unnarrowedTemplate`.
 * The harness must book all three exactly as the runner does.
 */
describe("codegraph-chain-tally dispatch-table parity with the production runner (c6xuu)", () => {
  let corpus: string;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeAll(() => {
    corpus = mkdtempSync(join(tmpdir(), "chain-tally-dispatch-"));
    write(
      "app/handlers.py",
      [
        "def on_a(x):",
        "    return x",
        "",
        "",
        "def on_b(x):",
        "    return x",
        "",
        "",
        'HANDLERS = {"a": on_a, "b": on_b}',
        "",
        "",
        "def route(kind, x):",
        "    return HANDLERS[kind](x)",
        "",
        "",
        "def route_a(x):",
        '    return HANDLERS["a"](x)',
        "",
        "",
        "def apply(cb, x):",
        "    return cb(x)",
        "",
        "",
        "def run(kind, x):",
        "    return apply(HANDLERS[kind], x)",
        "",
      ].join("\n"),
    );
    write(
      "app/service.rb",
      [
        "class Service",
        "  def self.call(*args)",
        "    new(*args).call",
        "  end",
        "",
        "  def call",
        "    nil",
        "  end",
        "end",
        "",
        "class Report < Service",
        "  def call",
        "    1",
        "  end",
        "end",
        "",
        "class Caller",
        "  def go",
        "    Service.call",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it.each(["python", "ruby"])(
    "books the same %s edges and receiver-kind counters as the production runner",
    async (lang) => {
      const harness = await run(corpus, lang, null, Number.MAX_SAFE_INTEGER, true, true, {
        timeOnly: true,
        kindStats: true,
      });
      const reference = await productionRun(corpus, lang);

      const answers = harness.rows
        .flatMap((row) =>
          row.runnerEdges.map(
            (edge) =>
              `${row.relPath} ${edge.callExpression} ${edge.sourceSymbolId} -> ${edge.targetRelPath}#${edge.targetSymbolId}`,
          ),
        )
        .sort();
      expect(answers).toEqual(reference.sourcedAnswers);
      expect(harness.kindStats).toEqual(reference.kinds);
    },
    60_000,
  );

  it("exercises every path the fixture exists for", async () => {
    const python = await run(corpus, "python", null, Number.MAX_SAFE_INTEGER, true, true, {
      timeOnly: true,
      kindStats: true,
    });
    // Dispatch-table sites are resolved and counted, never skipped.
    expect(python.dispatchTableSites).toBeGreaterThan(0);
    const tableRows = python.rows.filter((row) => row.dispatchTable);
    expect(tableRows).toHaveLength(python.dispatchTableSites);
    expect(tableRows.every((row) => row.runnerEdges.length > 0)).toBe(true);
    // The additive join: `apply(HANDLERS[kind], x)` books the callee edge AND the
    // callee-sourced fan over the table.
    const join = python.rows.find((row) => row.callText.startsWith("apply("));
    expect(join?.runnerEdges.length).toBeGreaterThan(1);

    const ruby = await productionRun(corpus, "ruby");
    expect(ruby.kinds.constant.unnarrowedTemplate).toBeGreaterThan(0);
  }, 60_000);
});
