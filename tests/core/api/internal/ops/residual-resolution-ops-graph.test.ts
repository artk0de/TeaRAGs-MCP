/**
 * ResidualResolutionOps over a real graph database and verdict store: a pass
 * that asks adds the model edge, a static re-walk of the file drops it, and the
 * next index run's cache-only re-apply restores it without a model call.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { ResidualResolutionOps } from "../../../../../src/core/api/internal/ops/residual-resolution-ops.js";
import type { ResidualCallSiteRow } from "../../../../../src/core/contracts/types/codegraph-residual.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";
import type { ResidualModelProvider } from "../../../../../src/core/domains/trajectory/codegraph/residual/types.js";

const PHYSICAL = fixturePhysicalCollectionName("code_fixture_v1");

const SITE: ResidualCallSiteRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 2,
  methodEndLine: 4,
  line: 3,
  column: 4,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users", "Team#users"],
  menuHash: "menu-1",
  menuOverflow: false,
};

const CONFIG = {
  kevUrls: ["http://gpu:8090"],
  kevThreshold: 0.7,
  concurrency: 2,
  menuLimit: 40,
  minMenu: 2,
  noneThreshold: 0.8,
  retentionDays: 180,
};

describe("ResidualResolutionOps on a real graph", () => {
  let tmp: string;
  let projectRoot: string;
  let client: DuckDbGraphClient;
  let modelCalls: number;

  const fakeKev: ResidualModelProvider = {
    id: "kev",
    threshold: 0.7,
    version: async () => "kev@fixture",
    health: async () => ({ ok: true }),
    resolveGroup: async (group) => {
      modelCalls += 1;
      return group.questions.map((q) => ({
        siteKey: q.siteKey,
        pick: "Firm#users",
        p: 0.93,
        probabilities: { "Firm#users": 0.93, "Team#users": 0.07 },
        questionPayload: group.methodSource,
      }));
    },
  };

  const staticWalk = async () =>
    client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [SITE] },
    );

  const modelEdges = async () =>
    client.queryAll<{ target_symbol_id: string; model: string }>(
      `SELECT target_symbol_id, model FROM cg_symbols_edges_method WHERE origin = 'model'`,
    );

  const ops = (createProvider?: (model: string) => ResidualModelProvider, config: typeof CONFIG = CONFIG) =>
    new ResidualResolutionOps({
      rootDir: tmp,
      codegraphPool: { acquireWrite: async () => ({ graphDb: client }) } as never,
      config,
      ...(createProvider ? { createProvider } : {}),
    });

  const request = { logicalName: "code_fixture", physicalCollectionName: PHYSICAL };

  beforeEach(async () => {
    modelCalls = 0;
    tmp = mkdtempSync(join(tmpdir(), "residual-ops-graph-"));
    projectRoot = join(tmp, "project");
    mkdirSync(join(projectRoot, "app"), { recursive: true });
    writeFileSync(
      join(projectRoot, "app/billing.rb"),
      "class Billing\n  def run(account)\n    account.users\n  end\nend\n",
    );
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    for (const owner of ["Firm", "Team"]) {
      const relPath = `app/models/${owner.toLowerCase()}.rb`;
      await client.upsertSymbols(relPath, [
        { symbolId: `${owner}#users`, fqName: `${owner}#users`, shortName: "users", relPath, scope: [owner] },
      ]);
    }
    await staticWalk();
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("asks once, then restores the edges a static re-walk dropped from the stored verdicts with no model call", async () => {
    const asked = await ops(() => fakeKev).resolveAfterIndex({ ...request, projectRoot, model: "kev" });

    expect(asked).toMatchObject({ outcome: "completed", mode: "ask", asked: 1, edgesApplied: 1 });
    expect(await modelEdges()).toEqual([{ target_symbol_id: "Firm#users", model: "kev" }]);

    await staticWalk();
    expect(await modelEdges()).toEqual([]);

    const reapplied = await ops(() => {
      throw new Error("a cache-only re-apply must not build a provider");
    }).resolveAfterIndex({ ...request, projectRoot });

    expect(reapplied).toMatchObject({
      outcome: "completed",
      mode: "cacheOnly",
      cacheHits: 1,
      asked: 0,
      edgesApplied: 1,
    });
    expect(await modelEdges()).toEqual([{ target_symbol_id: "Firm#users", model: "kev" }]);
    expect(modelCalls).toBe(1);
  });

  it("keeps indexing whole when the model is unreachable: the pass ends skipped and adds nothing", async () => {
    const down: ResidualModelProvider = {
      ...fakeKev,
      health: async () => ({ ok: false, reason: "connect ECONNREFUSED" }),
    };

    const report = await ops(() => down).resolveAfterIndex({ ...request, projectRoot, model: "kev" });

    expect(report).toMatchObject({ outcome: "skipped", mode: "ask", edgesApplied: 0 });
    expect(report?.reason).toMatch(/ECONNREFUSED/);
    expect(await modelEdges()).toEqual([]);
  });

  it("asks about and applies only sites whose menu reaches the floor, then recomputes the derived metrics", async () => {
    for (const owner of ["Client", "User"]) {
      const relPath = `app/models/${owner.toLowerCase()}.rb`;
      await client.upsertSymbols(relPath, [
        { symbolId: `${owner}#users`, fqName: `${owner}#users`, shortName: "users", relPath, scope: [owner] },
      ]);
    }
    const bigSite: ResidualCallSiteRow = {
      ...SITE,
      siteKey: "k-big",
      column: 12,
      receiverText: "owner",
      candidates: ["Client#users", "Firm#users", "Team#users", "User#users"],
      menuHash: "menu-4",
    };
    await client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [SITE, bigSite] },
    );
    await client.markDerivedStale();
    const askedSites: string[] = [];
    const recordingKev: ResidualModelProvider = {
      ...fakeKev,
      resolveGroup: async (group) => {
        askedSites.push(...group.questions.map((q) => q.siteKey));
        return fakeKev.resolveGroup(group);
      },
    };

    const report = await ops(() => recordingKev, { ...CONFIG, minMenu: 4 }).resolveAfterIndex({
      ...request,
      projectRoot,
      model: "kev",
    });

    expect(askedSites).toEqual(["k-big"]);
    expect(report).toMatchObject({ outcome: "completed", menuTooSmall: 1, edgesApplied: 1, derived: "recomputed" });
    expect(
      await client.queryAll<{ call_expression: string }>(
        `SELECT call_expression FROM cg_symbols_edges_method WHERE origin = 'model'`,
      ),
    ).toEqual([{ call_expression: "owner.users" }]);
    expect(await client.hasStaleDerivedTables()).toBe(false);
  });
});
