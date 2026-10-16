import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import {
  KevSessionBusyError,
  KevSessionLostError,
  KevStateTooLongError,
  KevTimeoutError,
} from "../../../../../../src/core/adapters/kev/errors.js";
import {
  RESIDUAL_QUESTION_VERSION,
  type ModelEdgeRow,
  type ModelExternalSiteRow,
  type ResidualCallSiteRow,
} from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import {
  residualQuestionHash,
  ResidualResolutionPass,
  type ResidualPassInput,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-resolution-pass.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualProviderLease,
  ResidualQuestion,
  ResidualQuestionGroup,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/types.js";
import type { ProgressUpdate } from "../../../../../../src/core/types.js";

const DAY = 86_400_000;

function row(over: Partial<ResidualCallSiteRow> & { siteKey: string }): ResidualCallSiteRow {
  return {
    sourceRelPath: "app/a.rb",
    methodSymbolId: "A#run",
    methodStartLine: 1,
    methodEndLine: 5,
    line: 2,
    column: 4,
    receiverText: "firm",
    member: "users",
    kind: "ambiguous",
    candidates: ["Firm#users", "Client#users"],
    menuHash: "menu-1",
    menuOverflow: false,
    ...over,
  };
}

class FakeProvider implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  readonly calls: ResidualQuestionGroup[] = [];
  healthy = true;
  modelVersion = "fake@1";
  failOn = new Set<string>();
  /** Methods whose first ask fails with `failure`; later asks answer. */
  failFirstOn = new Set<string>();
  failure: (method: string) => Error = (method) => new Error(`boom ${method}`);
  /** Methods whose ask settles only when the pass's signal aborts. */
  stallOn = new Set<string>();
  abortedAsks = 0;
  tooLongOn = new Set<string>();
  inFlight = 0;
  maxInFlight = 0;
  versionCalls = 0;
  healthCalls = 0;

  constructor(private readonly answer: (q: ResidualQuestion) => { pick: string | null; p: number }) {}

  version = async (): Promise<string> => {
    this.versionCalls++;
    return this.modelVersion;
  };

  health = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    this.healthCalls++;
    return this.healthy ? { ok: true } : { ok: false, reason: "connection refused" };
  };

  resolveGroup = async (group: ResidualQuestionGroup, signal?: AbortSignal): Promise<ResidualAnswer[]> => {
    this.calls.push(group);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.stallOn.has(group.methodSymbolId)) {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            this.abortedAsks++;
            reject(new Error(`aborted ${group.methodSymbolId}`));
          },
          { once: true },
        );
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.inFlight--;
    if (this.failOn.has(group.methodSymbolId)) throw this.failure(group.methodSymbolId);
    if (this.failFirstOn.delete(group.methodSymbolId)) throw this.failure(group.methodSymbolId);
    if (this.tooLongOn.has(group.methodSymbolId)) throw new KevStateTooLongError("http://gpu:1", "too long");
    return group.questions.map((q) => {
      const { pick, p } = this.answer(q);
      return {
        siteKey: q.siteKey,
        pick,
        p,
        probabilities: { [pick ?? "(none)"]: p },
        questionPayload: JSON.stringify(q),
      };
    });
  };
}

/** A provider whose hardware is leased per pass; records the lease lifecycle against the asks. */
class LeasedProvider extends FakeProvider {
  readonly events: string[] = [];
  acquireError: Error | undefined;
  lostOn = new Set<string>();

  acquire = async (): Promise<ResidualProviderLease> => {
    this.events.push("acquire");
    if (this.acquireError) throw this.acquireError;
    return {
      release: async () => {
        this.events.push("release");
      },
    };
  };

  constructor(answer: (q: ResidualQuestion) => { pick: string | null; p: number }) {
    super(answer);
    const ask = this.resolveGroup;
    this.resolveGroup = async (group, signal) => {
      this.events.push(`ask ${group.methodSymbolId}`);
      if (this.lostOn.has(group.methodSymbolId)) throw new KevSessionLostError("http://broker:8008", "lease-1");
      return ask(group, signal);
    };
  }
}

/** `stored` defaults to one edge per site, `changed` to true; a test sets either to model the adapter's diff. */
function fakeGraphDb(rows: ResidualCallSiteRow[]) {
  const applied: { model: string; edges: ModelEdgeRow[] }[] = [];
  const external: { model: string; sites: ModelExternalSiteRow[] }[] = [];
  const events: string[] = [];
  const state: { stored?: number; changed: boolean; recomputeError?: Error } = { changed: true };
  return {
    applied,
    external,
    events,
    state,
    staleMarks: () => events.filter((e) => e === "markStale").length,
    recomputes: () => events.filter((e) => e === "recompute").length,
    readResidualCallSites: async () => rows,
    applyModelEdges: async (model: string, edges: ModelEdgeRow[]) => {
      applied.push({ model, edges });
      return { stored: state.stored ?? edges.length, changed: state.changed };
    },
    applyModelExternalSites: async (model: string, sites: ModelExternalSiteRow[]) => {
      external.push({ model, sites });
    },
    markDerivedStale: async () => {
      events.push("markStale");
    },
    recomputeDerived: async () => {
      events.push("recompute");
      if (state.recomputeError) throw state.recomputeError;
    },
  };
}

const firmPick = () => ({ pick: "Firm#users", p: 0.9 });
const appliedSites = (graphDb: ReturnType<typeof fakeGraphDb>) => graphDb.applied.at(-1)?.edges.map((e) => e.siteKey);

describe("ResidualResolutionPass", () => {
  let rootDir: string;
  let store: ResidualVerdictStore;
  let sourceReads: string[];

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "residual-pass-"));
    store = await ResidualVerdictStore.open(rootDir, "code_test");
    sourceReads = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const run = async (
    graphDb: ReturnType<typeof fakeGraphDb>,
    provider: FakeProvider,
    over: Partial<Omit<ResidualPassInput, "graphDb" | "store" | "provider">> = {},
  ) =>
    new ResidualResolutionPass().run({
      graphDb,
      store,
      provider,
      mode: "ask",
      concurrency: 4,
      menuLimit: 40,
      minMenu: 1,
      noneThreshold: 0.8,
      retentionDays: 180,
      recomputeDerived: graphDb.recomputeDerived,
      readMethodSource: async (relPath, startLine, endLine) => {
        sourceReads.push(`${relPath}:${startLine}-${endLine}`);
        return `# source of ${relPath}`;
      },
      now: () => 1_000,
      ...over,
    });

  it("groups questions by enclosing method and drops duplicate questions", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", line: 3, receiverText: "client" }),
      row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go", methodStartLine: 10, methodEndLine: 20 }),
    ]);
    const provider = new FakeProvider(firmPick);

    const report = await run(graphDb, provider);

    expect(provider.calls).toHaveLength(2);
    const byMethod = Object.fromEntries(provider.calls.map((g) => [g.methodSymbolId, g]));
    expect(byMethod["A#run"].questions.map((q) => q.siteKey)).toEqual(["s1", "s2"]);
    expect(byMethod["A#run"].methodSource).toBe("# source of app/a.rb");
    expect(byMethod["B#go"].questions.map((q) => q.siteKey)).toEqual(["s3"]);
    expect(sourceReads.sort()).toEqual(["app/a.rb:1-5", "app/b.rb:10-20"]);
    expect(report).toMatchObject({
      outcome: "completed",
      mode: "ask",
      sites: 4,
      groups: 2,
      asked: 3,
      answered: 3,
      cacheHits: 0,
      edgesApplied: 3,
    });
    expect(report.reason).toBeUndefined();
  });

  describe("none of these", () => {
    it("counts a none verdict at or above the none threshold as externalByModel and stores it, not as an edge", async () => {
      const graphDb = fakeGraphDb([
        row({ siteKey: "ext" }),
        row({ siteKey: "unsure", line: 4 }),
        row({ siteKey: "firm", line: 5 }),
      ]);
      const provider = new FakeProvider((q) =>
        q.siteKey === "firm" ? { pick: "Firm#users", p: 0.9 } : { pick: null, p: q.siteKey === "ext" ? 0.8 : 0.79 },
      );

      const report = await run(graphDb, provider);

      expect(appliedSites(graphDb)).toEqual(["firm"]);
      expect(graphDb.external).toEqual([
        {
          model: "kev",
          sites: [{ siteKey: "ext", sourceRelPath: "app/a.rb", menuHash: "menu-1", model: "kev", p: 0.8 }],
        },
      ]);
      expect(report).toMatchObject({ answered: 3, sitesEdged: 1, externalByModel: 1, belowThreshold: 1 });
    });

    it("stores a none verdict with a null pick and re-applies it from the cache", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "ext" })]);
      await run(graphDb, new FakeProvider(() => ({ pick: null, p: 0.95 })));

      const report = await run(graphDb, new FakeProvider(firmPick), { mode: "cacheOnly" });

      expect(report).toMatchObject({ cacheHits: 1, externalByModel: 1, sitesEdged: 0 });
      expect(graphDb.external.at(-1)?.sites.map((s) => s.siteKey)).toEqual(["ext"]);
    });

    it("asks a one-entry menu: one class plus none is a binary question", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "solo", candidates: ["Firm#users"] })]);
      const provider = new FakeProvider(firmPick);

      const report = await run(graphDb, provider, { minMenu: 1 });

      expect(report).toMatchObject({ menuTooSmall: 0, asked: 1, sitesEdged: 1 });
    });

    it("keys verdicts by the menu hash folded with the question version, so wave-1 verdicts miss", async () => {
      expect(RESIDUAL_QUESTION_VERSION).toBe(2);
      expect(residualQuestionHash("menu-1")).not.toBe("menu-1");
      expect(residualQuestionHash("menu-1")).toBe(residualQuestionHash("menu-1"));
      await store.put([
        {
          siteKey: "s1",
          menuHash: "menu-1",
          model: "kev",
          modelVersion: "fake@1",
          pick: "Firm#users",
          p: 0.99,
          probabilities: {},
          questionPayload: "{}",
          createdAt: 1,
          lastSeenAt: 1,
        },
      ]);
      const provider = new FakeProvider(firmPick);

      const report = await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);

      expect(report).toMatchObject({ cacheHits: 0, asked: 1 });
      expect(provider.calls[0].questions[0].menuHash).toBe(residualQuestionHash("menu-1"));
    });
  });

  it("applies only verdicts at or above the provider threshold, then marks derived metrics stale", async () => {
    const graphDb = fakeGraphDb([row({ siteKey: "sure" }), row({ siteKey: "unsure", line: 4 })]);
    const provider = new FakeProvider((q) =>
      q.siteKey === "sure" ? { pick: "Firm#users", p: 0.7 } : { pick: "Client#users", p: 0.5 },
    );

    const report = await run(graphDb, provider);

    expect(graphDb.applied).toEqual([
      {
        model: "kev",
        edges: [
          {
            siteKey: "sure",
            sourceRelPath: "app/a.rb",
            sourceSymbolId: "A#run",
            targetSymbolId: "Firm#users",
            model: "kev",
            p: 0.7,
          },
        ],
      },
    ]);
    expect(graphDb.staleMarks()).toBe(1);
    expect(report).toMatchObject({ outcome: "completed", edgesApplied: 1, belowThreshold: 1, answered: 2 });
  });

  it("does not store an answer whose pick is off the menu", async () => {
    const graphDb = fakeGraphDb([row({ siteKey: "s1" })]);
    const provider = new FakeProvider(() => ({ pick: "Account#users", p: 0.99 }));

    const report = await run(graphDb, provider);

    expect(report).toMatchObject({ asked: 1, answered: 0, edgesApplied: 0 });
    expect(await store.findLatest([{ siteKey: "s1", menuHash: residualQuestionHash("menu-1") }], "kev")).toEqual([]);
  });

  it("reuses cached verdicts for the same site, menu and model version, and re-applies the full edge set", async () => {
    const rows = [row({ siteKey: "s1" }), row({ siteKey: "s2", line: 3 })];
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb(rows), provider);

    const second = fakeGraphDb(rows);
    const report = await run(second, provider);

    expect(provider.calls).toHaveLength(1);
    expect(report).toMatchObject({
      outcome: "completed",
      sites: 2,
      cacheHits: 2,
      groups: 0,
      asked: 0,
      answered: 0,
      edgesApplied: 2,
    });
    expect(appliedSites(second)).toEqual(["s1", "s2"]);
  });

  it("asks again when the menu changed or the served model version moved", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);

    await run(
      fakeGraphDb([row({ siteKey: "s1", menuHash: "menu-2", candidates: ["Firm#users", "User#users"] })]),
      provider,
    );
    provider.modelVersion = "fake@2";
    await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);

    expect(provider.calls).toHaveLength(3);
  });

  it("skips sites whose menu overflowed or exceeds the menu limit", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", menuOverflow: true }),
      row({ siteKey: "s3", candidates: ["A#users", "B#users", "C#users"] }),
    ]);
    const provider = new FakeProvider(firmPick);

    const report = await run(graphDb, provider, { menuLimit: 2 });

    expect(provider.calls.flatMap((g) => g.questions.map((q) => q.siteKey))).toEqual(["s1"]);
    expect(report).toMatchObject({ sites: 3, asked: 1, menuOverflow: 2, edgesApplied: 1 });
  });

  describe("menu floor", () => {
    const bigMenu = ["Client#users", "Firm#users", "Team#users", "User#users"];

    it("neither asks about nor applies a site whose menu is under the floor", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "small" }), row({ siteKey: "big", line: 4, candidates: bigMenu })]);
      const provider = new FakeProvider(firmPick);

      const report = await run(graphDb, provider, { minMenu: 4 });

      expect(provider.calls.flatMap((g) => g.questions.map((q) => q.siteKey))).toEqual(["big"]);
      expect(appliedSites(graphDb)).toEqual(["big"]);
      expect(report).toMatchObject({ sites: 2, menuTooSmall: 1, menuOverflow: 0, asked: 1, edgesApplied: 1 });
    });

    it("does not re-apply a stored verdict for a site under the floor in cacheOnly mode", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "small" }), row({ siteKey: "big", line: 4, candidates: bigMenu })]);
      await run(graphDb, new FakeProvider(firmPick), { minMenu: 1 });
      const provider = new FakeProvider(firmPick);

      const report = await run(graphDb, provider, { mode: "cacheOnly", minMenu: 4 });

      expect(provider.calls).toEqual([]);
      expect(appliedSites(graphDb)).toEqual(["big"]);
      expect(report).toMatchObject({ mode: "cacheOnly", menuTooSmall: 1, cacheHits: 1, edgesApplied: 1 });
    });
  });

  describe("derived metrics", () => {
    it("marks the derived tables stale and recomputes them when the applied edge set changed", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "s1" })]);

      const report = await run(graphDb, new FakeProvider(firmPick));

      expect(graphDb.events).toEqual(["markStale", "recompute"]);
      expect(report.derived).toBe("recomputed");
    });

    it("leaves the derived tables alone when the applied edge set did not change", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "s1" })]);
      graphDb.state.changed = false;

      const report = await run(graphDb, new FakeProvider(firmPick));

      expect(graphDb.events).toEqual([]);
      expect(report.derived).toBe("unchanged");
    });

    it("completes with the derived tables left stale when the recompute fails", async () => {
      const graphDb = fakeGraphDb([row({ siteKey: "s1" })]);
      graphDb.state.recomputeError = new Error("daemon gone");

      const report = await run(graphDb, new FakeProvider(firmPick));

      expect(graphDb.events).toEqual(["markStale", "recompute"]);
      expect(report).toMatchObject({ outcome: "completed", derived: "stale", edgesApplied: 1 });
    });
  });

  it("reports distinct stored edges apart from the sites that reached the threshold", async () => {
    const graphDb = fakeGraphDb([row({ siteKey: "s1" }), row({ siteKey: "s2", column: 9 })]);
    graphDb.state.stored = 1;

    const report = await run(graphDb, new FakeProvider(firmPick));

    expect(report).toMatchObject({ sitesEdged: 2, edgesApplied: 1 });
  });

  it("counts the sites of a group refused as too long and completes without them", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", line: 3 }),
      row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go" }),
    ]);
    const provider = new FakeProvider(firmPick);
    provider.tooLongOn.add("A#run");

    const report = await run(graphDb, provider);

    expect(report).toMatchObject({
      outcome: "completed",
      asked: 3,
      answered: 1,
      tooLong: 2,
      failedGroups: 0,
      edgesApplied: 1,
    });
    expect(report.reason).toBeUndefined();
    expect(appliedSites(graphDb)).toEqual(["s3"]);
  });

  it("keeps the verdicts of groups that answered when one group throws, and resumes with the rest", async () => {
    const rows = [row({ siteKey: "s1" }), row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go" })];
    const provider = new FakeProvider(firmPick);
    provider.failOn.add("B#go");

    const first = await run(fakeGraphDb(rows), provider);
    expect(first).toMatchObject({
      outcome: "completed",
      failedGroups: 1,
      edgesApplied: 1,
      reason: "1 group(s) failed: boom B#go",
    });

    provider.failOn.clear();
    provider.calls.length = 0;
    const second = await run(fakeGraphDb(rows), provider);

    expect(provider.calls.map((g) => g.methodSymbolId)).toEqual(["B#go"]);
    expect(second).toMatchObject({ outcome: "completed", cacheHits: 1, asked: 1, edgesApplied: 2 });
  });

  it("stops asking and ends skipped when more groups fail than allowed, still applying the verdicts it holds", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "cached", methodSymbolId: "A#cached" })]), provider);
    provider.calls.length = 0;
    const rows = [
      row({ siteKey: "cached", methodSymbolId: "A#cached" }),
      ...["A#a", "A#b", "A#c"].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method })),
    ];
    for (const method of ["A#a", "A#b", "A#c"]) provider.failOn.add(method);
    const graphDb = fakeGraphDb(rows);

    const report = await run(graphDb, provider, { maxGroupFailures: 1, concurrency: 1 });

    expect(report.outcome).toBe("skipped");
    expect(report.reason).toMatch(/^2 group\(s\) failed: boom A#/);
    expect(report).toMatchObject({ failedGroups: 2, asked: 2, cacheHits: 1, edgesApplied: 1 });
    expect(provider.calls).toHaveLength(2);
    expect(appliedSites(graphDb)).toEqual(["cached"]);
  });

  it("cancels the asks still in flight when the failure breaker trips, counting them apart from failures", async () => {
    const provider = new FakeProvider(firmPick);
    const stalled = ["A#c", "A#d", "A#e", "A#f"];
    for (const method of ["A#a", "A#b"]) provider.failOn.add(method);
    for (const method of stalled) provider.stallOn.add(method);
    const rows = ["A#a", "A#b", ...stalled].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb(rows), provider, { maxGroupFailures: 1, concurrency: 6 });

    expect(provider.abortedAsks).toBe(4);
    expect(report).toMatchObject({ outcome: "skipped", failedGroups: 2, abortedGroups: 4, answered: 0 });
    expect(report.reason).toMatch(/^2 group\(s\) failed: boom A#/);

    provider.failOn.clear();
    provider.stallOn.clear();
    provider.calls.length = 0;
    const second = await run(fakeGraphDb(rows), provider, { concurrency: 6 });

    expect(provider.calls.map((g) => g.methodSymbolId).sort()).toEqual(["A#a", "A#b", ...stalled]);
    expect(second).toMatchObject({ outcome: "completed", abortedGroups: 0, answered: 6 });
  });

  it("cancels the asks still in flight once the lease is lost", async () => {
    const provider = new LeasedProvider(firmPick);
    provider.lostOn.add("A#a");
    provider.stallOn.add("A#b");
    const rows = ["A#b", "A#a"].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method }));

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 2 });

    expect(provider.abortedAsks).toBe(1);
    expect(report).toMatchObject({ outcome: "skipped", failedGroups: 1, abortedGroups: 1 });
  });

  it("reports a timeout as one, keeping the error's cause in the reason, and logs each failed group", async () => {
    const provider = new FakeProvider(firmPick);
    provider.failOn.add("A#a");
    provider.failure = () =>
      new KevTimeoutError(["http://gpu:1"], 120_000, new Error("The operation was aborted due to timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb([row({ siteKey: "s1", methodSymbolId: "A#a" })]), provider);

    expect(report.reason).toBe(
      "1 group(s) failed: Kev did not answer within 120s (cause: The operation was aborted due to timeout)",
    );
    expect(log).toHaveBeenCalledWith("[Residual] group failed: method=A#a questions=1 code=INFRA_KEV_TIMEOUT");
  });

  const kevTimeout = () => new KevTimeoutError(["http://gpu:1"], 300_000);

  it("requeues a group that timed out at the tail of the queue and stores its answer from the second ask", async () => {
    const provider = new FakeProvider(firmPick);
    provider.failFirstOn.add("A#a");
    provider.failure = kevTimeout;
    const rows = ["A#a", "A#b", "A#c"].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method }));
    const progress: ProgressUpdate[] = [];

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 1, onProgress: (p) => progress.push(p) });

    expect(provider.calls.map((g) => g.methodSymbolId)).toEqual(["A#a", "A#b", "A#c", "A#a"]);
    expect(report).toMatchObject({
      outcome: "completed",
      asked: 3,
      answered: 3,
      failedGroups: 0,
      requeuedGroups: 1,
      edgesApplied: 3,
    });
    expect(progress.at(-1)).toMatchObject({ current: 3, total: 3, percentage: 100 });
  });

  it("counts a group that times out again after its requeue as failed", async () => {
    const provider = new FakeProvider(firmPick);
    provider.failOn.add("A#a");
    provider.failure = kevTimeout;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rows = ["A#a", "A#b"].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method }));

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 1 });

    expect(provider.calls.map((g) => g.methodSymbolId)).toEqual(["A#a", "A#b", "A#a"]);
    expect(report).toMatchObject({ outcome: "completed", failedGroups: 1, requeuedGroups: 1, answered: 1 });
  });

  it("requeues only timeouts; any other failure counts at once", async () => {
    const provider = new FakeProvider(firmPick);
    provider.failOn.add("A#a");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb([row({ siteKey: "s0", methodSymbolId: "A#a" })]), provider);

    expect(provider.calls).toHaveLength(1);
    expect(report).toMatchObject({ failedGroups: 1, requeuedGroups: 0 });
  });

  it("lets failures scattered over a large pass run up to 2% of its groups before tripping", async () => {
    const provider = new FakeProvider(firmPick);
    const rows = Array.from({ length: 300 }, (_, i) => row({ siteKey: `s${i}`, methodSymbolId: `M#m${i}` }));
    for (const i of [0, 50, 100, 150, 200, 250]) provider.failOn.add(`M#m${i}`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 1 });

    expect(provider.calls).toHaveLength(300);
    expect(report).toMatchObject({ outcome: "completed", failedGroups: 6, answered: 294 });
  });

  it("trips on the relative budget once failures pass the larger of the floor and the rate", async () => {
    const provider = new FakeProvider(firmPick);
    const rows = Array.from({ length: 300 }, (_, i) => row({ siteKey: `s${i}`, methodSymbolId: `M#m${i}` }));
    for (const i of [0, 40, 80, 120, 160, 200, 240]) provider.failOn.add(`M#m${i}`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 1 });

    expect(provider.calls).toHaveLength(241);
    expect(report).toMatchObject({ outcome: "skipped", failedGroups: 7 });
  });

  it("trips when consecutive groups fail, even inside the failure budget", async () => {
    const provider = new FakeProvider(firmPick);
    const rows = Array.from({ length: 20 }, (_, i) => row({ siteKey: `s${i}`, methodSymbolId: `M#m${i}` }));
    for (let i = 0; i < 5; i++) provider.failOn.add(`M#m${i}`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 1, maxGroupFailures: 10 });

    expect(provider.calls).toHaveLength(5);
    expect(report).toMatchObject({ outcome: "skipped", failedGroups: 5, answered: 0 });
  });

  it("restarts the consecutive-failure count at every answered group", async () => {
    const provider = new FakeProvider(firmPick);
    const rows = Array.from({ length: 20 }, (_, i) => row({ siteKey: `s${i}`, methodSymbolId: `M#m${i}` }));
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) provider.failOn.add(`M#m${i}`);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await run(fakeGraphDb(rows), provider, {
      concurrency: 1,
      maxGroupFailures: 10,
      maxConsecutiveGroupFailures: 5,
    });

    expect(provider.calls).toHaveLength(20);
    expect(report).toMatchObject({ outcome: "completed", failedGroups: 8, answered: 12 });
  });

  it("ends skipped when the provider is unhealthy, asks nothing and re-applies the newest cached verdicts", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);
    provider.calls.length = 0;
    provider.healthy = false;
    const graphDb = fakeGraphDb([row({ siteKey: "s1" }), row({ siteKey: "s2", line: 3 })]);

    const report = await run(graphDb, provider);

    expect(report).toMatchObject({
      outcome: "skipped",
      reason: "provider kev unavailable: connection refused",
      sites: 2,
      cacheHits: 1,
      groups: 1,
      asked: 0,
      edgesApplied: 1,
    });
    expect(provider.calls).toEqual([]);
    expect(appliedSites(graphDb)).toEqual(["s1"]);
    expect(graphDb.staleMarks()).toBe(1);
  });

  it("cacheOnly never calls the provider and re-applies the newest verdict per site across model versions", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);
    provider.modelVersion = "fake@2";
    await run(fakeGraphDb([row({ siteKey: "s2", line: 3 })]), provider);
    provider.calls.length = 0;
    provider.versionCalls = 0;
    provider.healthCalls = 0;
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s2", line: 3 }),
      row({ siteKey: "s3", line: 4 }),
    ]);

    const report = await run(graphDb, provider, { mode: "cacheOnly" });

    expect(provider.calls).toEqual([]);
    expect(provider.versionCalls + provider.healthCalls).toBe(0);
    expect(report).toMatchObject({
      outcome: "completed",
      mode: "cacheOnly",
      sites: 3,
      cacheHits: 2,
      groups: 1,
      asked: 0,
      edgesApplied: 2,
    });
    expect(appliedSites(graphDb)).toEqual(["s1", "s2"]);
  });

  it("keeps verdicts of current sites alive and expires the ones unseen past the retention", async () => {
    const provider = new FakeProvider(firmPick);
    await run(fakeGraphDb([row({ siteKey: "kept" }), row({ siteKey: "gone", line: 9 })]), provider, { now: () => 0 });

    await run(fakeGraphDb([row({ siteKey: "kept" })]), provider, { mode: "cacheOnly", now: () => 200 * DAY });

    const left = await store.findLatest(
      [
        { siteKey: "kept", menuHash: residualQuestionHash("menu-1") },
        { siteKey: "gone", menuHash: residualQuestionHash("menu-1") },
      ],
      "kev",
    );
    expect(left.map((v) => [v.siteKey, v.lastSeenAt])).toEqual([["kept", 200 * DAY]]);
  });

  it("keeps at most `concurrency` groups in flight", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ siteKey: `s${i}`, methodSymbolId: `M#m${i}` }));
    const provider = new FakeProvider(firmPick);

    const report = await run(fakeGraphDb(rows), provider, { concurrency: 3 });

    expect(provider.calls).toHaveLength(12);
    expect(provider.maxInFlight).toBe(3);
    expect(report.edgesApplied).toBe(12);
  });

  it("reports resolving-residual progress per finished group and stage durations", async () => {
    const graphDb = fakeGraphDb([
      row({ siteKey: "s1" }),
      row({ siteKey: "s3", sourceRelPath: "app/b.rb", methodSymbolId: "B#go" }),
    ]);
    const progress: ProgressUpdate[] = [];
    let clock = 0;

    const report = await run(graphDb, new FakeProvider(firmPick), {
      concurrency: 1,
      now: () => (clock += 10),
      onProgress: (p) => progress.push(p),
    });

    expect(progress.map((p) => [p.phase, p.current, p.total, p.percentage])).toEqual([
      ["resolving-residual", 1, 2, 50],
      ["resolving-residual", 2, 2, 100],
    ]);
    expect(report.durations.totalMs).toBeGreaterThan(0);
    expect(report.durations.totalMs).toBe(report.durations.readMs + report.durations.askMs + report.durations.applyMs);
  });
  describe("leased provider", () => {
    it("never acquires when every eligible site is answered from the cache", async () => {
      const provider = new LeasedProvider(firmPick);
      await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);
      provider.events.length = 0;

      const report = await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);

      expect(provider.events).toEqual([]);
      expect(report).toMatchObject({ outcome: "completed", cacheHits: 1, asked: 0, edgesApplied: 1 });
    });

    it("never acquires in cacheOnly mode", async () => {
      const provider = new LeasedProvider(firmPick);

      await run(fakeGraphDb([row({ siteKey: "s1" })]), provider, { mode: "cacheOnly" });

      expect(provider.events).toEqual([]);
    });

    it("acquires once before the first ask and releases after the last one", async () => {
      const provider = new LeasedProvider(firmPick);
      const updates: ProgressUpdate[] = [];
      const rows = [row({ siteKey: "s1" }), row({ siteKey: "s2", methodSymbolId: "A#other" })];

      const report = await run(fakeGraphDb(rows), provider, { concurrency: 1, onProgress: (u) => updates.push(u) });

      expect(provider.events).toEqual(["acquire", "ask A#run", "ask A#other", "release"]);
      expect(report).toMatchObject({ outcome: "completed", answered: 2 });
      expect(updates[0]).toMatchObject({ phase: "resolving-residual", current: 0, total: 2 });
      expect(updates[0].message).toMatch(/acquiring GPU session/);
    });

    it("releases the lease when the pass throws mid-ask", async () => {
      const provider = new LeasedProvider(firmPick);
      const onProgress = (update: ProgressUpdate) => {
        if (update.current > 0) throw new Error("renderer died");
      };

      await expect(run(fakeGraphDb([row({ siteKey: "s1" })]), provider, { onProgress })).rejects.toThrow(
        "renderer died",
      );

      expect(provider.events).toEqual(["acquire", "ask A#run", "release"]);
    });

    it("ends skipped with the broker's reason when the session is busy, applying the cached verdicts", async () => {
      const provider = new LeasedProvider(firmPick);
      await run(fakeGraphDb([row({ siteKey: "s1" })]), provider);
      provider.events.length = 0;
      provider.acquireError = new KevSessionBusyError("http://broker:8008", "other-host:42", "KEV");
      const graphDb = fakeGraphDb([row({ siteKey: "s1" }), row({ siteKey: "s2", line: 3 })]);

      const report = await run(graphDb, provider);

      expect(provider.events).toEqual(["acquire"]);
      expect(report).toMatchObject({ outcome: "skipped", cacheHits: 1, asked: 0, edgesApplied: 1 });
      expect(report.reason).toBe(
        "provider kev session not acquired: gpu-session-busy: other-host:42 (KEV) at http://broker:8008",
      );
    });

    it("stops asking and ends skipped as soon as the lease is lost", async () => {
      const provider = new LeasedProvider(firmPick);
      provider.lostOn.add("A#b");
      const rows = ["A#a", "A#b", "A#c"].map((method, i) => row({ siteKey: `s${i}`, methodSymbolId: method }));

      const report = await run(fakeGraphDb(rows), provider, { concurrency: 1 });

      expect(provider.events).toEqual(["acquire", "ask A#a", "ask A#b", "release"]);
      expect(report).toMatchObject({ outcome: "skipped", answered: 1, failedGroups: 1, edgesApplied: 1 });
      expect(report.reason).toBe("1 group(s) failed: gpu-session-lost: lease lease-1 at http://broker:8008");
    });
  });
});
