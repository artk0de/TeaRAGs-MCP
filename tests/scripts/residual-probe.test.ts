import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diffResidualSnapshots,
  evaluateScenario,
  takeResidualSnapshot,
  type ResidualSnapshot,
} from "../../scripts/lib/residual-probe-core.js";
import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../src/core/adapters/duckdb/graph-session.js";
import { ResidualVerdictStore } from "../../src/core/adapters/duckdb/residual-verdict-store.js";
import type { ResidualVerdict } from "../../src/core/contracts/types/codegraph-residual.js";
import type { ResidualCallSiteRow } from "../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../src/core/domains/maintenance/migration/database/runner.js";

const site = (over: Partial<ResidualCallSiteRow>): ResidualCallSiteRow => ({
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 10,
  methodEndLine: 20,
  line: 12,
  column: 6,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users", "Team#users"],
  menuHash: "menu-1",
  menuOverflow: false,
  ...over,
});

const verdict = (over: Partial<ResidualVerdict>): ResidualVerdict => ({
  siteKey: "k1",
  menuHash: "menu-1",
  model: "kev",
  modelVersion: "kev-1",
  pick: "Firm#users",
  p: 0.9,
  probabilities: { "Firm#users": 0.9, "Team#users": 0.1 },
  questionPayload: "{}",
  createdAt: 1_000,
  lastSeenAt: 1_000,
  ...over,
});

/** Replaces the file's declarations with `symbolIds`. */
const declare = async (client: DuckDbGraphClient, relPath: string, symbolIds: string[]): Promise<void> =>
  client.upsertSymbols(
    relPath,
    symbolIds.map((symbolId) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split("#")[1],
      relPath,
      scope: [symbolId.split("#")[0]],
    })),
  );

describe("takeResidualSnapshot", () => {
  let tmp: string;
  let graphPath: string;

  /** Billing has three residual sites: k1 and k2 carry model edges, k3 overflows its menu. */
  const seedGraph = async (tamper?: (client: DuckDbGraphClient) => Promise<void>): Promise<void> => {
    const client = new DuckDbGraphClient({ path: graphPath });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    await declare(client, "app/models/firm.rb", ["Firm#users", "Firm#name"]);
    await declare(client, "app/models/team.rb", ["Team#users", "Team#name"]);
    for (const relPath of ["app/models/firm.rb", "app/models/team.rb"]) {
      await client.upsertFile({ relPath, language: "ruby" }, { fileEdges: [], methodEdges: [] });
    }
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        residualCallSites: [
          site({}),
          site({
            siteKey: "k2",
            member: "name",
            kind: "ambiguous",
            candidates: ["Firm#name", "Team#name"],
            menuHash: "menu-2",
          }),
          site({ siteKey: "k3", member: "id", candidates: [], menuHash: "menu-3", menuOverflow: true }),
        ],
      },
    );
    await client.applyModelEdges("kev", [
      {
        siteKey: "k1",
        sourceRelPath: "app/billing.rb",
        sourceSymbolId: "Billing#run",
        targetSymbolId: "Firm#users",
        model: "kev",
        p: 0.92,
      },
      {
        siteKey: "k2",
        sourceRelPath: "app/billing.rb",
        sourceSymbolId: "Billing#run",
        targetSymbolId: "Team#name",
        model: "kev",
        p: 0.75,
      },
    ]);
    await tamper?.(client);
    await client.close();
  };

  const seedVerdicts = async (verdicts: ResidualVerdict[]): Promise<string> => {
    const store = await ResidualVerdictStore.open(tmp, "code_test");
    await store.put(verdicts);
    await store.close();
    return ResidualVerdictStore.pathFor(tmp, "code_test");
  };

  const snapshot = async (
    verdictPath?: string,
    options: { fileExists?: (relPath: string) => boolean; threshold?: number } = {},
  ): Promise<ResidualSnapshot> => {
    const graph = new DuckDbGraphSession({ path: graphPath, accessMode: "READ_ONLY" });
    await graph.open();
    const verdicts = verdictPath ? new DuckDbGraphSession({ path: verdictPath, accessMode: "READ_ONLY" }) : undefined;
    await verdicts?.open();
    try {
      return await takeResidualSnapshot({
        graph,
        verdicts,
        now: 5_000,
        threshold: options.threshold ?? 0.7,
        hubLimit: 5,
        ...(options.fileExists ? { fileExists: options.fileExists } : {}),
      });
    } finally {
      await graph.close();
      await verdicts?.close();
    }
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "residual-probe-"));
    graphPath = join(tmp, "g.duckdb");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("counts residual rows by kind and overflow, model edges by model and p bucket, with no orphans", async () => {
    await seedGraph();

    const state = await snapshot();

    expect(state.residualSites).toEqual({
      total: 3,
      byKind: { ambiguous: 1, dynamic: 2 },
      menuOverflow: 1,
      distinctMenuHashes: 3,
    });
    expect(state.modelEdges.total).toBe(2);
    expect(state.modelEdges.byModel).toEqual({ kev: 2 });
    expect(state.modelEdges.byPBucket).toEqual({ "0.7-0.8": 1, "0.9+": 1 });
    expect(state.orphans.total).toBe(0);
    expect(state.verdicts).toBeNull();
  });

  it("names every model edge whose source file, target symbol or residual site is gone", async () => {
    await seedGraph(async (client) => {
      await client.run("DELETE FROM cg_symbols WHERE symbol_id = 'Team#name'");
      await client.run("DELETE FROM cg_residual_call_sites WHERE site_key = 'k1'");
      await client.run("DELETE FROM cg_symbols_files WHERE rel_path = 'app/billing.rb'");
    });

    const state = await snapshot(undefined, { fileExists: (relPath) => relPath !== "app/billing.rb" });

    expect(state.orphans.sourceFileMissing).toBe(2);
    expect(state.orphans.sourceFileMissingOnDisk).toBe(2);
    expect(state.orphans.targetSymbolMissing).toBe(1);
    expect(state.orphans.siteNotResidual).toBe(1);
    expect(state.orphans.samples.targetSymbolMissing[0]).toMatchObject({ siteKey: "k2", targetSymbolId: "Team#name" });
    expect(state.orphans.samples.siteNotResidual[0]).toMatchObject({ siteKey: "k1" });
  });

  it("flags a model edge on an overflowing site and one whose target left the site's menu", async () => {
    await seedGraph(async (client) => {
      await client.run("UPDATE cg_residual_call_sites SET menu_overflow = true WHERE site_key = 'k1'");
      await client.run(`UPDATE cg_residual_call_sites SET candidates = '["Firm#name"]' WHERE site_key = 'k2'`);
    });

    const state = await snapshot();

    expect(state.orphans.siteOverflow).toBe(1);
    expect(state.orphans.targetNotInMenu).toBe(1);
    expect(state.orphans.total).toBe(2);
  });

  it("reads verdict-store age and coverage of the current sites, and the edges stored p keeps at the threshold", async () => {
    await seedGraph();
    const verdictPath = await seedVerdicts([
      verdict({ createdAt: 1_000, lastSeenAt: 1_500 }),
      verdict({ siteKey: "k2", menuHash: "menu-2", pick: "Team#name", p: 0.75, createdAt: 2_000, lastSeenAt: 2_000 }),
      verdict({ siteKey: "k2", menuHash: "menu-old", pick: "Firm#name", p: 0.99, createdAt: 500, lastSeenAt: 500 }),
    ]);

    const atDefault = await snapshot(verdictPath);
    const atStricter = await snapshot(verdictPath, { threshold: 0.8 });

    expect(atDefault.verdicts).toMatchObject({
      rows: 3,
      distinctModels: 1,
      oldestCreatedAt: 500,
      newestCreatedAt: 2_000,
      sitesCovered: 2,
      sitesUncovered: 0,
      keptAtThreshold: 2,
      edgesWithoutVerdict: 0,
    });
    expect(atStricter.verdicts?.keptAtThreshold).toBe(1);
  });

  it("refuses a graph whose schema predates the residual migrations instead of reporting zero", async () => {
    const legacy = new DuckDbGraphSession({ path: graphPath });
    await legacy.open();
    await legacy.exec("CREATE TABLE cg_symbols_edges_method (source_symbol_id VARCHAR)");
    await legacy.close();

    await expect(snapshot()).rejects.toThrow(/migrations 053\/054/);
  });

  it("ranks the most-called targets with their static and model fan-in", async () => {
    await seedGraph();

    const state = await snapshot();

    expect(state.hubs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbolId: "Firm#users", staticFanIn: 0, modelFanIn: 1 }),
        expect.objectContaining({ symbolId: "Team#name", staticFanIn: 0, modelFanIn: 1 }),
      ]),
    );
  });
});

describe("diffResidualSnapshots / evaluateScenario", () => {
  const base = (over: Partial<ResidualSnapshot> = {}): ResidualSnapshot => ({
    takenAt: 1_000,
    label: "before",
    threshold: 0.7,
    residualSites: { total: 10, byKind: { ambiguous: 6, dynamic: 4 }, menuOverflow: 1, distinctMenuHashes: 10 },
    modelEdges: { total: 2, byModel: { kev: 2 }, byPBucket: { "0.9+": 2 }, edgeSetHash: "h1", edgeKeys: ["a", "b"] },
    orphans: {
      total: 0,
      sourceFileMissing: 0,
      sourceFileMissingOnDisk: null,
      targetSymbolMissing: 0,
      targetPathStale: 0,
      siteNotResidual: 0,
      siteOverflow: 0,
      targetNotInMenu: 0,
      samples: {
        sourceFileMissing: [],
        targetSymbolMissing: [],
        targetPathStale: [],
        siteNotResidual: [],
        siteOverflow: [],
        targetNotInMenu: [],
      },
    },
    verdicts: {
      rows: 9,
      distinctModels: 1,
      byModel: { kev: 9 },
      oldestCreatedAt: 100,
      newestCreatedAt: 900,
      oldestLastSeenAt: 100,
      newestLastSeenAt: 900,
      sitesCovered: 9,
      sitesUncovered: 0,
      keptAtThreshold: 2,
      edgesWithoutVerdict: 0,
    },
    derived: { stale: false, metricsRows: 5, cycleRows: 0 },
    hubs: [],
    ...over,
  });

  it("names the edges added and removed between two snapshots", () => {
    const after = base({
      takenAt: 2_000,
      modelEdges: { total: 2, byModel: { kev: 2 }, byPBucket: { "0.9+": 2 }, edgeSetHash: "h2", edgeKeys: ["b", "c"] },
    });

    const diff = diffResidualSnapshots(base(), after);

    expect(diff.edgesAdded).toEqual(["c"]);
    expect(diff.edgesRemoved).toEqual(["a"]);
    expect(diff.edgeSetUnchanged).toBe(false);
  });

  it("passes B2 when a rerun leaves the edge set and the verdict store untouched", () => {
    const after = base({ takenAt: 2_000 });

    const lines = evaluateScenario("B2", base(), after);

    expect(lines.every((line) => line.pass)).toBe(true);
  });

  it("fails B2 when the rerun wrote a new verdict, and the always-on orphan check fails on any orphan", () => {
    const after = base({
      takenAt: 2_000,
      verdicts: { ...base().verdicts!, rows: 10, newestCreatedAt: 1_500 },
      orphans: { ...base().orphans, total: 1, targetSymbolMissing: 1 },
    });

    const failed = evaluateScenario("B2", base(), after).filter((line) => !line.pass);

    expect(failed.map((line) => line.check)).toEqual(
      expect.arrayContaining(["no orphan model edges", "no new verdicts (0 Kev questions)"]),
    );
  });

  it("checks B5 against fewer residual rows and fewer model edges", () => {
    const after = base({
      takenAt: 2_000,
      residualSites: { ...base().residualSites, total: 9 },
      modelEdges: { total: 1, byModel: { kev: 1 }, byPBucket: { "0.9+": 1 }, edgeSetHash: "h3", edgeKeys: ["b"] },
    });

    const lines = evaluateScenario("B5", base(), after);

    expect(lines.every((line) => line.pass)).toBe(true);
  });

  it("rejects an unknown scenario id", () => {
    expect(() => evaluateScenario("B99", base(), base())).toThrow(/unknown scenario/);
  });
});
