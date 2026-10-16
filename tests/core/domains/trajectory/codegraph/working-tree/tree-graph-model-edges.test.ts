/**
 * Model edges in the working-tree graph (bd tea-rags-mcp-2m83f.39, item 3). The
 * tree build's static re-walk drops a changed file's `origin = 'model'` rows;
 * the build re-applies them from the cached verdicts (`cacheOnly`, never
 * asking a model), so a graph answer over a worktree path carries the same
 * model edges the index does. Each case builds a real base graph whose model
 * edges came from a verdict store, edits the tree, and reads the output graph.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { ResidualVerdictStore } from "../../../../../../src/core/adapters/duckdb/residual-verdict-store.js";
import type { ResidualCallSiteRow } from "../../../../../../src/core/contracts/types/codegraph-residual.js";
import {
  buildWorkingTreeGraph,
  type WorkingTreeGraphBuildInput,
  type WorkingTreeGraphResidualInput,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  CODEGRAPH_POOL_FACTORY_MODULE,
  LANGUAGE_MODULE_PATH,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  withReadOnlyGraph,
  type TreeGraphFixture,
} from "./__helpers__/tree-graph-fixture.js";

const LOGICAL = "code_wtgraph";
const MODEL = "kev";
const THRESHOLD = 0.5;
const verdictRoots: string[] = [];

afterAll(() => {
  cleanupTreeGraphFixtures();
  for (const dir of verdictRoots) rmSync(dir, { recursive: true, force: true });
});

const PA = "export class Pa {\n  ping(): number {\n    return 1;\n  }\n}\n";
const PB = "export class Pb {\n  ping(): number {\n    return 2;\n  }\n}\n";
// `Pb#ping` is gone from the tree: an unchanged file's model edge into it has no target.
const PB_RENAMED = "export class Pb {\n  pong(): number {\n    return 2;\n  }\n}\n";
const CALLER =
  "export function go(h: any): number {\n  return h.ping();\n}\n\nexport function other(): number {\n  return 1;\n}\n";
// The `go` site is untouched; only an unrelated method body moved.
const CALLER_OTHER_BODY = CALLER.replace("return 1;", "return 41 + 1;");
// A third `ping` joins the `go` site's menu: its verdict is stale.
const CALLER_NEW_MENU = `${CALLER}\nexport class Pc {\n  ping(): number {\n    return 3;\n  }\n}\n`;
const WATCHER = "export function watch(h: any): number {\n  return h.ping();\n}\n";

/** `caller.ts` picks `Pa#ping`, `watcher.ts` picks `Pb#ping`, both above the threshold. */
const PICKS: Record<string, { pick: string; p: number }> = {
  "caller.ts": { pick: "Pa#ping", p: 0.9 },
  "watcher.ts": { pick: "Pb#ping", p: 0.8 },
};

interface ModelFixture {
  fixture: TreeGraphFixture;
  residual: WorkingTreeGraphResidualInput;
}

/** A base graph whose model edges were applied from the verdicts a store holds — the index's shape after a pass. */
async function buildModelFixture(): Promise<ModelFixture> {
  const fixture = await buildTreeGraphFixture({
    "pa.ts": PA,
    "pb.ts": PB,
    "caller.ts": CALLER,
    "watcher.ts": WATCHER,
  });
  const verdictRootDir = mkdtempSync(join(tmpdir(), "wtg-verdicts-"));
  verdictRoots.push(verdictRootDir);
  const client = new DuckDbGraphClient({ path: fixture.snapshotPath });
  await client.init();
  try {
    const sites = await client.readResidualCallSites();
    expect(sites.map((s) => s.sourceRelPath).sort()).toEqual(["caller.ts", "watcher.ts"]);
    const store = await ResidualVerdictStore.open(verdictRootDir, LOGICAL);
    try {
      await store.put(sites.map(verdictFor));
    } finally {
      await store.close();
    }
    await client.applyModelEdges(
      MODEL,
      sites.map((s) => ({
        siteKey: s.siteKey,
        sourceRelPath: s.sourceRelPath,
        sourceSymbolId: s.methodSymbolId,
        targetSymbolId: PICKS[s.sourceRelPath].pick,
        model: MODEL,
        p: PICKS[s.sourceRelPath].p,
      })),
    );
    await client.checkpoint();
  } finally {
    await client.close();
  }
  const wal = `${fixture.snapshotPath}.wal`;
  if (existsSync(wal) && statSync(wal).size === 0) unlinkSync(wal);
  return {
    fixture,
    residual: { verdictRootDir, logicalName: LOGICAL, model: MODEL, threshold: THRESHOLD, menuLimit: 16, minMenu: 2 },
  };
}

function verdictFor(site: ResidualCallSiteRow) {
  const { pick, p } = PICKS[site.sourceRelPath];
  return {
    siteKey: site.siteKey,
    menuHash: site.menuHash,
    model: MODEL,
    modelVersion: "v1",
    pick,
    p,
    probabilities: { [pick]: p },
    questionPayload: "{}",
    createdAt: 1,
    lastSeenAt: Date.now(),
  };
}

function inputFor(
  { fixture, residual }: ModelFixture,
  changedRelPaths: string[],
  overrides: Partial<WorkingTreeGraphBuildInput> = {},
): WorkingTreeGraphBuildInput {
  return {
    snapshotPath: fixture.snapshotPath,
    outputRoot: mkdtempSync(join(fixture.outputRoot, "build-")),
    physicalCollectionName: PHYSICAL,
    treeRoot: fixture.treeRoot,
    changedRelPaths,
    deletedRelPaths: [],
    providerConfig: {
      languageModulePath: LANGUAGE_MODULE_PATH,
      migrationsModulePath: MIGRATIONS_MODULE_PATH,
      poolFactoryModulePath: CODEGRAPH_POOL_FACTORY_MODULE,
    },
    residual,
    ...overrides,
  };
}

/** Every model method edge as `source#symbol -> target#symbol origin model p`, sorted. */
async function modelEdges(dbPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<{ e: string }>(
      `SELECT source_rel_path || '#' || source_symbol_id || ' -> ' || target_rel_path || '#' || target_symbol_id
              || ' ' || origin || ' ' || model || ' ' || CAST(p AS VARCHAR) AS e
         FROM cg_symbols_edges_method WHERE origin = 'model'`,
    );
    return rows.map((r) => r.e).sort();
  });
}

/** Model file edges as `source -> target`, sorted. */
async function modelFileEdges(dbPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<{ e: string }>(
      "SELECT source_rel_path || ' -> ' || target_rel_path AS e FROM cg_symbols_edges_file WHERE origin = 'model'",
    );
    return rows.map((r) => r.e).sort();
  });
}

/** Method edges naming a target symbol no `cg_symbols` row declares. */
async function danglingEdges(dbPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<{ e: string }>(
      `SELECT m.source_rel_path || '#' || m.source_symbol_id || ' -> ' || m.target_symbol_id AS e
         FROM cg_symbols_edges_method m
        WHERE m.target_symbol_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM cg_symbols s WHERE s.symbol_id = m.target_symbol_id)`,
    );
    return rows.map((r) => r.e).sort();
  });
}

const CALLER_EDGE = "caller.ts#go -> pa.ts#Pa#ping model kev 0.9";
const WATCHER_EDGE = "watcher.ts#watch -> pb.ts#Pb#ping model kev 0.8";

/**
 * Holds the verdict store READ_WRITE from another process, the way the
 * residual pass of an index run does, until the returned stop is called.
 */
async function holdStoreReadWrite(storePath: string): Promise<() => Promise<void>> {
  const duckdbEntry = pathToFileURL(createRequire(import.meta.url).resolve("@duckdb/node-api")).href;
  const script = `const { DuckDBInstance } = await import(${JSON.stringify(duckdbEntry)});
const instance = await DuckDBInstance.create(${JSON.stringify(storePath)});
await instance.connect();
process.stdout.write("held\\n");
process.stdin.on("data", () => process.exit(0));`;
  const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => {
      resolve();
    });
    child.once("exit", (code) => {
      reject(new Error(`store holder exited early (${String(code)})`));
    });
  });
  return async () =>
    new Promise<void>((resolve) => {
      child.removeAllListeners("exit");
      child.once("exit", () => {
        resolve();
      });
      child.stdin?.write("x");
    });
}

describe("buildWorkingTreeGraph — model edges of changed files (bd tea-rags-mcp-2m83f.39)", () => {
  it("re-applies a changed file's model edge when its call site is unchanged", async () => {
    const model = await buildModelFixture();
    model.fixture.writeTree("caller.ts", CALLER_OTHER_BODY);

    const built = await buildWorkingTreeGraph(inputFor(model, ["caller.ts"]));

    expect(await modelEdges(built.dbPath)).toEqual([CALLER_EDGE, WATCHER_EDGE]);
    expect(await modelFileEdges(built.dbPath)).toEqual(["caller.ts -> pa.ts", "watcher.ts -> pb.ts"]);
    expect(built.modelEdges).toEqual({ stored: 2 });
  }, 120_000);

  it("drops a changed file's model edge when its menu changed (the verdict is stale)", async () => {
    const model = await buildModelFixture();
    model.fixture.writeTree("caller.ts", CALLER_NEW_MENU);

    const built = await buildWorkingTreeGraph(inputFor(model, ["caller.ts"]));

    expect(await modelEdges(built.dbPath)).toEqual([WATCHER_EDGE]);
    expect(await modelFileEdges(built.dbPath)).toEqual(["watcher.ts -> pb.ts"]);
  }, 120_000);

  it("drops an unchanged file's model edge whose target the tree removed — no dangling edge", async () => {
    const model = await buildModelFixture();
    model.fixture.writeTree("pb.ts", PB_RENAMED);

    const built = await buildWorkingTreeGraph(inputFor(model, ["pb.ts"]));

    expect(await modelEdges(built.dbPath)).toEqual([CALLER_EDGE]);
    expect(await modelFileEdges(built.dbPath)).toEqual(["caller.ts -> pa.ts"]);
    expect(await danglingEdges(built.dbPath)).toEqual([]);
  }, 120_000);

  it("builds without model edges for changed files when the verdict store is absent", async () => {
    const model = await buildModelFixture();
    model.fixture.writeTree("caller.ts", CALLER_OTHER_BODY);
    const absent = { ...model.residual, verdictRootDir: join(model.residual.verdictRootDir, "missing") };

    const built = await buildWorkingTreeGraph(inputFor(model, ["caller.ts"], { residual: absent }));

    expect(await modelEdges(built.dbPath)).toEqual([WATCHER_EDGE]);
    expect(built.modelEdges).toBeUndefined();
  }, 120_000);

  it("degrades, without failing, when another process holds the verdict store read-write", async () => {
    const model = await buildModelFixture();
    model.fixture.writeTree("caller.ts", CALLER_OTHER_BODY);
    const release = await holdStoreReadWrite(
      ResidualVerdictStore.pathFor(model.residual.verdictRootDir, model.residual.logicalName),
    );
    let built;
    try {
      built = await buildWorkingTreeGraph(inputFor(model, ["caller.ts"]));
    } finally {
      await release();
    }

    expect(await modelEdges(built.dbPath)).toEqual([WATCHER_EDGE]);
    expect(built.modelEdges).toEqual({ unavailable: expect.stringMatching(/verdict store unreadable/) as string });
  }, 120_000);
});
