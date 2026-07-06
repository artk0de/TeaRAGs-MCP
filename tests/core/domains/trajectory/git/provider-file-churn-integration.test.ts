/**
 * Task 4 correctness capstone — the incremental git file-signal cache, wired
 * end to end. Two real-git integration proofs against a tiny temp repo (no
 * child_process mock — mirrors the real-git harness in
 * `adapters/vcs/git/commit-file-numstat.test.ts`):
 *
 * 1. SIGNAL EQUALITY (the headline invariant): git file enrichment run BOTH
 *    ways for the same HEAD+window — via the new `FileChurnDiscovery` and via
 *    the legacy `buildFileSignalMap`/`readNumstatLog` with NO discovery — MUST
 *    produce identical per-file signals (commitCount, linesAdded, linesDeleted,
 *    and the ORDER-AGNOSTIC set of commit shas). This exposes the binary-row
 *    divergence: `parseCommitFileNumstat` kept binary-only file rows the legacy
 *    `parseNumstatOutput` skips, so a binary-only file's commitCount diverged.
 *
 * 2. PROVIDER INCREMENTAL (the wiring): a warm provider run at HEAD c(n+1) with
 *    a file-churn store persisted from HEAD c(n) issues a `from..to` RANGE read
 *    (not a whole-repo read) and produces the SAME signals as a cold run at the
 *    same HEAD.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VcsAdapterFactory } from "../../../../../src/core/adapters/vcs/factory.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { FileChurnData } from "../../../../../src/core/adapters/vcs/types.js";
import { GitEnrichmentCache } from "../../../../../src/core/domains/trajectory/git/infra/cache.js";
import { FileChurnDiscovery } from "../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import { buildFileSignalMap } from "../../../../../src/core/domains/trajectory/git/infra/file-reader.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";

// The FILE-phase blame pool spawns worker_threads. Mock it so this provider
// integration test never spawns one — blame results are irrelevant here (the
// returned overlays are raw FileChurnData; blame lives in a separate WeakMap).
// Mirrors the mock in provider.test.ts.
const { blamePoolBlame } = vi.hoisted(() => ({ blamePoolBlame: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js", () => ({
  BlameWorkerPool: vi.fn(function () {
    return { blame: blamePoolBlame, close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

// Real-git provider tests spawn many git subprocesses; under the full parallel
// suite (compounded by the machine-wide EDR git-spawn throttle) they run well
// past the 5s default. Match the real-git fixture precedent (30s hook timeouts
// in file-discovery.test.ts / blame-cache / churn-walk fixtures).
vi.setConfig({ testTimeout: 30000 });

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guards against running real git outside the temp tree — same
// pattern as commit-file-numstat.test.ts / client-catfile.test.ts.
const TMP_BASE = realpathSync(tmpdir());

const TIMEOUT_MS = 30000;
const WINDOW_MONTHS = 12;

/** Fixture commits dated relative to NOW so any reasonable `--since` window
 *  (the 12-month provider default) includes every one — absolute dates would
 *  fall outside the window as wall-clock advances. */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

function gitIn(cwd: string, args: string[], isoDate: string): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`provider-file-churn-integration.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  }).trim();
}

/** Per-file assertion of git file-signal equality, ORDER-AGNOSTIC on the commit
 *  sha set (the canonical fold order of the incremental path may differ from
 *  git-log order under merges, but the derived signals must match). */
function expectSignalsEqual(actual: Map<string, FileChurnData>, expected: Map<string, FileChurnData>): void {
  expect(new Set(actual.keys())).toEqual(new Set(expected.keys()));
  for (const [path, exp] of expected) {
    const act = actual.get(path)!;
    expect(act.commits.length).toBe(exp.commits.length);
    expect(act.linesAdded).toBe(exp.linesAdded);
    expect(act.linesDeleted).toBe(exp.linesDeleted);
    expect(new Set(act.commits.map((c) => c.sha))).toEqual(new Set(exp.commits.map((c) => c.sha)));
  }
}

describe("git file signal equality — FileChurnDiscovery vs legacy readNumstatLog (real git)", () => {
  let tmp: string;
  let adapter: GitCliAdapter;

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-filechurn-eq-"));
    const g = (args: string[], isoDate: string): string => gitIn(tmp, args, isoDate);

    const T1 = daysAgoIso(10);
    const T2 = daysAgoIso(9);
    const T3 = daysAgoIso(8);

    g(["init", "-q", "-b", "main"], T1);
    g(["config", "user.email", "t@example.com"], T1);
    g(["config", "user.name", "Test"], T1);
    g(["config", "commit.gpgsign", "false"], T1);
    g(["config", "diff.algorithm", "myers"], T1);

    // c1 — create src/a.ts (3 lines): +3/-0.
    writeFileSync(join(tmp, "a.ts"), "x\ny\nz\n");
    g(["add", "-A"], T1);
    g(["commit", "-q", "-m", "c1: add a.ts"], T1);

    // c2 — edit a.ts (+3/-1) AND add a binary file. img.png is touched ONLY by
    // this binary row: the legacy parser drops it entirely; the numstat reader
    // used to keep it as {0,0}, giving it a phantom commitCount of 1.
    writeFileSync(join(tmp, "a.ts"), "x\ny1\ny2\ny3\nz\n");
    writeFileSync(join(tmp, "img.png"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]));
    g(["add", "-A"], T2);
    g(["commit", "-q", "-m", "c2: edit a.ts + add binary img.png"], T2);

    // c3 — append one line to a.ts (+1/-0).
    writeFileSync(join(tmp, "a.ts"), "x\ny1\ny2\ny3\nz\nw\n");
    g(["add", "-A"], T3);
    g(["commit", "-q", "-m", "c3: append to a.ts"], T3);

    adapter = new GitCliAdapter(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("produces identical per-file signals for the same HEAD+window (binary-only file dropped by both)", async () => {
    // NEW path: a cold FileChurnDiscovery (no store → full repo-wide read).
    const discovery = new FileChurnDiscovery(adapter, { maxAgeMonths: WINDOW_MONTHS, timeoutMs: TIMEOUT_MS });
    const newMap = await buildFileSignalMap(adapter, new GitEnrichmentCache(), WINDOW_MONTHS, TIMEOUT_MS, discovery);

    // LEGACY path: buildFileSignalMap with NO discovery → adapter.readNumstatLog
    // (parseNumstatOutput), same window.
    const legacyMap = await buildFileSignalMap(adapter, new GitEnrichmentCache(), WINDOW_MONTHS, TIMEOUT_MS);

    expectSignalsEqual(newMap, legacyMap);

    // Positive anchor: the text file's signals are the summed churn across all
    // three commits (so the equality above is non-trivial), and the binary-only
    // file is absent from BOTH maps.
    const aTs = legacyMap.get("a.ts")!;
    expect(aTs.commits.length).toBe(3);
    expect(aTs.linesAdded).toBe(7); // 3 + 3 + 1
    expect(aTs.linesDeleted).toBe(1); // 0 + 1 + 0
    expect(newMap.has("img.png")).toBe(false);
    expect(legacyMap.has("img.png")).toBe(false);
  });
});

describe("GitEnrichmentProvider file-churn wiring — incremental range read (real git)", () => {
  let tmp: string;
  let realAdapter: GitCliAdapter;
  let provider: GitEnrichmentProvider;
  let numstatSpy: ReturnType<typeof vi.spyOn>;
  let prevDataDir: string | undefined;

  const head = (): string => gitIn(tmp, ["rev-parse", "HEAD"], daysAgoIso(0));

  beforeEach(() => {
    // Isolated store dir so the cold→warm persistence is self-contained per
    // test (the provider constructs FileChurnDiscoveryStore off TEA_RAGS_DATA_DIR).
    prevDataDir = process.env.TEA_RAGS_DATA_DIR;
    process.env.TEA_RAGS_DATA_DIR = mkdtempSync(join(TMP_BASE, "git-filechurn-store-"));

    tmp = mkdtempSync(join(TMP_BASE, "git-filechurn-prov-"));
    const g = (args: string[], iso: string): string => gitIn(tmp, args, iso);
    const T1 = daysAgoIso(10);
    const T2 = daysAgoIso(9);

    g(["init", "-q", "-b", "main"], T1);
    g(["config", "user.email", "t@example.com"], T1);
    g(["config", "user.name", "Test"], T1);
    g(["config", "commit.gpgsign", "false"], T1);
    g(["config", "diff.algorithm", "myers"], T1);

    // c1 — add a.ts + b.ts.
    writeFileSync(join(tmp, "a.ts"), "a1\na2\n");
    writeFileSync(join(tmp, "b.ts"), "b1\n");
    g(["add", "-A"], T1);
    g(["commit", "-q", "-m", "c1: add a.ts + b.ts"], T1);

    // c2 — edit a.ts (the cold-run HEAD).
    writeFileSync(join(tmp, "a.ts"), "a1\na2\na3\n");
    g(["add", "-A"], T2);
    g(["commit", "-q", "-m", "c2: edit a.ts"], T2);

    realAdapter = new GitCliAdapter(tmp);
    // Spy calls through to the real impl — records the (sinceDate, range) args.
    numstatSpy = vi.spyOn(realAdapter, "readCommitFileNumstat");
    // The provider builds its adapter via the factory; hand it the spied real one.
    vi.spyOn(VcsAdapterFactory, "create").mockResolvedValue(realAdapter as never);

    provider = new GitEnrichmentProvider();
  });

  afterEach(async () => {
    await provider.finalizeSignals().catch(() => undefined);
    vi.restoreAllMocks();
    const storeDir = process.env.TEA_RAGS_DATA_DIR;
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    process.env.TEA_RAGS_DATA_DIR = prevDataDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cold run reads whole-repo; a warm run at the next HEAD issues a from..to range read and matches cold signals", async () => {
    const paths = ["a.ts", "b.ts"];

    // COLD run at c2 — empty store → whole-repo read (range absent).
    const coldHead = head();
    await provider.streamFileBatch(tmp, paths);
    expect(numstatSpy).toHaveBeenCalledTimes(1);
    expect(numstatSpy.mock.calls[0][1]).toBeUndefined();
    await provider.finalizeSignals();

    // New commit c3 touching only b.ts — HEAD moves forward.
    writeFileSync(join(tmp, "b.ts"), "b1\nb2\n");
    gitIn(tmp, ["add", "-A"], daysAgoIso(5));
    gitIn(tmp, ["commit", "-q", "-m", "c3: edit b.ts"], daysAgoIso(5));
    const warmHead = head();

    // WARM run at c3 — the c2 snapshot is an ancestor → incremental top-up
    // over c2..c3, NOT another whole-repo read.
    numstatSpy.mockClear();
    const warmResult = await provider.streamFileBatch(tmp, paths);
    expect(numstatSpy).toHaveBeenCalledTimes(1);
    expect(numstatSpy.mock.calls[0][1]).toEqual({ fromSha: coldHead, toSha: warmHead });

    // The incremental signals equal a cold full recompute at c3 (legacy path).
    const legacy = await realAdapter.readNumstatLog(
      new Date(Date.now() - WINDOW_MONTHS * 30 * 86400 * 1000),
      TIMEOUT_MS,
    );
    expectSignalsEqual(warmResult as unknown as Map<string, FileChurnData>, legacy);
  });
});
