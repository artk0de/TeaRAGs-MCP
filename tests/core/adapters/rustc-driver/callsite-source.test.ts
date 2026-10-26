/**
 * The process-scoped `RustCallSiteSource` over the rustc call-site runner
 * (bd s3i8m T8): admission as the domain decides it, the
 * runner statuses mapped onto the port's acquisition variants, and one
 * acquisition per project root in flight.
 */
import { describe, expect, it } from "vitest";

import type {
  RustcCallSiteAcquisition,
  RustcCallSiteDiagnostics,
  RustcCallSiteRunOptions,
} from "../../../../src/core/adapters/rustc-driver/callsite-runner.js";
import {
  createRustcCallSiteSource,
  processRustcCallSiteSource,
} from "../../../../src/core/adapters/rustc-driver/callsite-source.js";
import type { RustCallSiteIndex, RustCallSiteSourceConfig } from "../../../../src/core/contracts/types/language.js";

const CONFIG: RustCallSiteSourceConfig = { enabled: true, timeoutSec: 3600, maxRssMb: 12_288, spawn: "allowed" };
const ROOT = "/ws";
const index = (identity: string): RustCallSiteIndex => ({ identity, definitionAt: () => null });
const diagnostics = (over: Partial<RustcCallSiteDiagnostics> = {}): RustcCallSiteDiagnostics => ({
  ranCargoCheck: false,
  unitCount: 0,
  failedCrates: [],
  missingUnits: 0,
  retried: false,
  wallMs: 0,
  ...over,
});

function fakeRunner(outcomes: RustcCallSiteAcquisition[]) {
  const calls: RustcCallSiteRunOptions[] = [];
  return {
    calls,
    acquire: async (options: RustcCallSiteRunOptions): Promise<RustcCallSiteAcquisition> => {
      calls.push(options);
      return outcomes.shift() ?? { status: "disabled", diagnostics: diagnostics() };
    },
  };
}

const spawnAdmission = () => "spawn" as const;

describe("createRustcCallSiteSource — admission", () => {
  it("passes the caller's admission and the config's budgets to the runner", async () => {
    const runner = fakeRunner([{ status: "ok", index: index("a"), diagnostics: diagnostics({ wallMs: 7 }) }]);
    const source = createRustcCallSiteSource({ ...CONFIG, timeoutSec: 60, maxRssMb: 512 }, runner);
    await source.acquire({ projectRoot: ROOT, admission: spawnAdmission });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ projectRoot: ROOT, timeoutSec: 60, maxRssMb: 512 });
    expect(runner.calls[0]?.admission?.(["a.rs"])).toBe("spawn");
  });

  it("forces reuseOnly when the config says spawn: never, whatever the caller admits", async () => {
    const runner = fakeRunner([{ status: "noCache", diagnostics: diagnostics() }]);
    const source = createRustcCallSiteSource({ ...CONFIG, spawn: "never" }, runner);
    await source.acquire({ projectRoot: ROOT, admission: spawnAdmission });
    expect(runner.calls[0]?.admission?.(["a.rs"])).toBe("reuseOnly");
  });

  it("tells the runner spawn: never so it never upgrades reuseOnly to a cargo run", async () => {
    const runner = fakeRunner([{ status: "noCache", diagnostics: diagnostics() }]);
    const source = createRustcCallSiteSource({ ...CONFIG, spawn: "never" }, runner);
    await source.acquire({ projectRoot: ROOT, admission: spawnAdmission });
    expect(runner.calls[0]?.spawn).toBe("never");
  });

  it("answers skipped/disabled without running when the slot is off", async () => {
    const runner = fakeRunner([]);
    const source = createRustcCallSiteSource({ ...CONFIG, enabled: false }, runner);
    expect(await source.acquire({ projectRoot: ROOT, admission: spawnAdmission })).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe("createRustcCallSiteSource — status mapping", () => {
  const acquireOne = async (outcome: RustcCallSiteAcquisition) =>
    createRustcCallSiteSource(CONFIG, fakeRunner([outcome])).acquire({ projectRoot: ROOT, admission: spawnAdmission });

  it("maps ok and partial to indexed with the run's wall time, units and failed crate targets", async () => {
    const ok = await acquireOne({
      status: "ok",
      index: index("a"),
      diagnostics: diagnostics({
        wallMs: 7,
        unitCount: 4,
        failedCrates: [{ packageId: "path+file:///ws/x#x@0.1.0", target: "x", firstError: "E0433" }],
      }),
    });
    expect(ok).toMatchObject({ kind: "indexed", cacheHit: false, wallMs: 7, units: 4, failedCrates: ["x"] });
    const partial = await acquireOne({ status: "partial", index: index("b"), diagnostics: diagnostics() });
    expect(partial.kind).toBe("indexed");
  });

  it("maps reused to an indexed cache hit", async () => {
    const reused = await acquireOne({ status: "reused", index: index("a"), diagnostics: diagnostics() });
    expect(reused).toMatchObject({ kind: "indexed", cacheHit: true });
  });

  it("maps noCache to skipped/noBulkNoCache", async () => {
    expect(await acquireOne({ status: "noCache", diagnostics: diagnostics() })).toEqual({
      kind: "skipped",
      reason: "noBulkNoCache",
    });
  });

  it("maps a latched failure to latched with its hint", async () => {
    const latched = await acquireOne({
      status: "failed",
      diagnostics: diagnostics({ latched: { reason: "allUnitsFailed", detail: "E0433" }, hint: "cargo fetch" }),
    });
    expect(latched).toEqual({ kind: "latched", reason: "allUnitsFailed", detail: "E0433", hint: "cargo fetch" });
  });

  it("maps a budget breach to latched with the breach reason", async () => {
    const breach = await acquireOne({
      status: "failed",
      diagnostics: diagnostics({ budget: { reason: "timeout", detail: "wall 3600 s" } }),
    });
    expect(breach).toEqual({ kind: "latched", reason: "timeout", detail: "wall 3600 s" });
  });

  it("maps any other failure to latched/exit with its detail", async () => {
    const failed = await acquireOne({ status: "failed", diagnostics: diagnostics({ detail: "-V failed" }) });
    expect(failed).toEqual({ kind: "latched", reason: "exit", detail: "-V failed" });
  });

  it("maps unavailable to skipped/unavailable carrying the install hint, distinct from disabled", async () => {
    const unavailable = await acquireOne({ status: "unavailable", diagnostics: diagnostics({ hint: "rustup …" }) });
    expect(unavailable).toEqual({ kind: "skipped", reason: "unavailable", hint: "rustup …" });
  });

  it("maps disabled to skipped/disabled", async () => {
    expect(await acquireOne({ status: "disabled", diagnostics: diagnostics() })).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
  });

  it("never rejects when the runner throws", async () => {
    const source = createRustcCallSiteSource(CONFIG, {
      acquire: async () => {
        throw new Error("boom");
      },
    });
    expect(await source.acquire({ projectRoot: ROOT, admission: spawnAdmission })).toEqual({
      kind: "latched",
      reason: "exit",
      detail: "boom",
    });
  });
});

describe("createRustcCallSiteSource — memo", () => {
  it("runs once for concurrent acquisitions of one project root", async () => {
    const runner = fakeRunner([{ status: "ok", index: index("a"), diagnostics: diagnostics() }]);
    const source = createRustcCallSiteSource(CONFIG, runner);
    const [first, second] = await Promise.all([
      source.acquire({ projectRoot: ROOT, admission: spawnAdmission }),
      source.acquire({ projectRoot: ROOT, admission: spawnAdmission }),
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("re-runs a settled acquisition and keeps the earlier index object while the identity holds", async () => {
    const runner = fakeRunner([
      { status: "ok", index: index("a"), diagnostics: diagnostics() },
      { status: "ok", index: index("a"), diagnostics: diagnostics() },
      { status: "ok", index: index("b"), diagnostics: diagnostics() },
    ]);
    const source = createRustcCallSiteSource(CONFIG, runner);
    const indexOf = async () => {
      const acquisition = await source.acquire({ projectRoot: ROOT, admission: spawnAdmission });
      return acquisition.kind === "indexed" ? acquisition.index : undefined;
    };
    const first = await indexOf();
    const same = await indexOf();
    const changed = await indexOf();
    expect(runner.calls).toHaveLength(3);
    expect(same).toBe(first);
    expect(changed?.identity).toBe("b");
  });

  it("keeps acquisitions of different project roots apart", async () => {
    const runner = fakeRunner([
      { status: "ok", index: index("a"), diagnostics: diagnostics() },
      { status: "ok", index: index("b"), diagnostics: diagnostics() },
    ]);
    const source = createRustcCallSiteSource(CONFIG, runner);
    await Promise.all([
      source.acquire({ projectRoot: "/a", admission: spawnAdmission }),
      source.acquire({ projectRoot: "/b", admission: spawnAdmission }),
    ]);
    expect(runner.calls.map((call) => call.projectRoot)).toEqual(["/a", "/b"]);
  });

  it("shares one source per distinct config per process", () => {
    expect(processRustcCallSiteSource(CONFIG)).toBe(processRustcCallSiteSource({ ...CONFIG }));
    expect(processRustcCallSiteSource(CONFIG)).not.toBe(processRustcCallSiteSource({ ...CONFIG, spawn: "never" }));
  });
});
