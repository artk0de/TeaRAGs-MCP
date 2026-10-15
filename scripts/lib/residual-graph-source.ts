/**
 * Where the residual validation scripts read from: a project alias resolves to
 * its codegraph database (the highest generation on disk) and its verdict
 * store; both open READ_ONLY. A graph file the codegraph daemon holds is read
 * through the daemon's `exportSnapshot` op instead — the same path the
 * working-tree graph overlay takes — so the probe never fights the daemon's
 * lock. The verdict store is opened by an index / resolve run only for its
 * pass, so a busy store means a run is in flight: snapshot after it ends.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as ConfigModule_ from "../../src/bootstrap/config/index.js";
import type * as FactoryModule_ from "../../src/bootstrap/factory.js";
import { CodegraphDbFiles } from "../../src/core/adapters/duckdb/codegraph-db-files.js";
import { DuckDbGraphSession } from "../../src/core/adapters/duckdb/graph-session.js";
import { ResidualVerdictStore } from "../../src/core/adapters/duckdb/residual-verdict-store.js";
import type * as ApiModule_ from "../../src/core/api/index.js";
import type { PhysicalCollectionName } from "../../src/core/contracts/types/collection-identity.js";

type ConfigModule = typeof ConfigModule_;
type FactoryModule = typeof FactoryModule_;
type ApiModule = typeof ApiModule_;

export interface ResidualSourcePaths {
  graphDb: string;
  verdictDb: string | null;
  /** The generation the graph file belongs to; absent for an explicit `--graph-db`. */
  physicalCollectionName?: string;
  projectRoot?: string;
}

export interface ResidualSourceArgs {
  project?: string;
  graphDb?: string;
  verdictDb?: string;
  /** Overrides the highest generation on disk (`code_x_v12`). */
  generation?: string;
  projectRoot?: string;
  /** `TEA_RAGS_DATA_DIR`, else `~/.tea-rags`; also the codegraph root unless `codegraphRoot` is set. */
  dataDir?: string;
  codegraphRoot?: string;
}

export interface OpenedResidualSources {
  paths: ResidualSourcePaths;
  graph: DuckDbGraphSession;
  verdicts?: DuckDbGraphSession;
  readVia: "direct" | "daemon-snapshot";
  close: () => Promise<void>;
}

/**
 * The compiled build the daemon client is loaded from. The daemon keys its
 * socket on `computeBuildFingerprint` (the module's directory), so a client
 * loaded from `src/` under tsx waits on a socket no `build/` daemon serves.
 * No fallback to `src/`: a missing build fails loudly.
 */
export function resolveBuildDir(buildDir?: string): string {
  const dir = buildDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "build");
  if (!existsSync(join(dir, "bootstrap", "factory.js"))) {
    throw new Error(`no compiled build at ${dir}; run \`npm run build\` or pass --build <dir>`);
  }
  return dir;
}

const importFromBuild = async <T>(buildDir: string, relPath: string): Promise<T> =>
  (await import(pathToFileURL(join(buildDir, relPath)).href)) as T;

const LOCK_CONTENTION = /Could not set lock on file|Conflicting lock is held/u;

function isLockContention(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (LOCK_CONTENTION.test(e.message) || (e as { lockContention?: boolean }).lockContention === true) return true;
  }
  return false;
}

const generationNumber = (name: string): number => Number(/_v(\d+)$/u.exec(name)?.[1] ?? -1);

export async function resolveResidualSourcePaths(args: ResidualSourceArgs): Promise<ResidualSourcePaths> {
  if (args.graphDb) {
    return {
      graphDb: args.graphDb,
      verdictDb: args.verdictDb ?? null,
      ...(args.projectRoot ? { projectRoot: args.projectRoot } : {}),
    };
  }
  if (!args.project) throw new Error("pass --project <alias> or --graph-db <path>");
  const dataDir = args.dataDir ?? process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const rootDir = args.codegraphRoot ?? dataDir;
  const { CollectionRegistry, collectionHoldsCodegraphData } = await import("../../src/core/api/index.js");
  const entry = new CollectionRegistry(dataDir, { codegraphDataProbe: collectionHoldsCodegraphData }).findByName(
    args.project,
  );
  if (entry === null) throw new Error(`no registered project named ${args.project}`);
  const files = new CodegraphDbFiles(rootDir);
  const generations = files
    .listCollectionGenerationNames(entry.collectionName)
    .filter((name) => existsSync(files.pathFor(name)));
  const physical =
    args.generation ??
    [...generations].sort((a, b) => generationNumber(b) - generationNumber(a))[0] ??
    entry.collectionName;
  const verdictDb = args.verdictDb ?? ResidualVerdictStore.pathFor(rootDir, entry.collectionName);
  return {
    graphDb: files.pathFor(physical as PhysicalCollectionName),
    verdictDb: existsSync(verdictDb) ? verdictDb : null,
    physicalCollectionName: physical,
    projectRoot: args.projectRoot ?? entry.path,
  };
}

async function openReadOnly(path: string): Promise<DuckDbGraphSession> {
  const session = new DuckDbGraphSession({ path, accessMode: "READ_ONLY" });
  await session.open();
  return session;
}

/** Ask this build's codegraph daemon for a consistent copy of the generation; resolves to the copy's path. */
async function exportThroughDaemon(
  physicalCollectionName: string,
  targetDir: string,
  buildDir: string,
): Promise<string> {
  const { getZodConfig, parseAppConfig } = await importFromBuild<ConfigModule>(buildDir, "bootstrap/config/index.js");
  const { wireCodegraph } = await importFromBuild<FactoryModule>(buildDir, "bootstrap/factory.js");
  const { CollectionRegistry, collectionHoldsCodegraphData } = await importFromBuild<ApiModule>(
    buildDir,
    "core/api/index.js",
  );
  const config = parseAppConfig();
  const wired = wireCodegraph(
    config,
    getZodConfig(),
    new CollectionRegistry(config.paths.appData, { codegraphDataProbe: collectionHoldsCodegraphData }),
  );
  if (wired === undefined) throw new Error("codegraph is disabled in this environment (CODEGRAPH_ENABLED)");
  const target = join(targetDir, "graph.duckdb");
  try {
    await wired.pool.exportSnapshot(physicalCollectionName as PhysicalCollectionName, target);
  } finally {
    await wired.pool.closeAll();
  }
  return target;
}

export async function openResidualSources(
  paths: ResidualSourcePaths,
  options: { buildDir?: string } = {},
): Promise<OpenedResidualSources> {
  if (!existsSync(paths.graphDb)) throw new Error(`no codegraph database at ${paths.graphDb}`);
  let graph: DuckDbGraphSession;
  let readVia: OpenedResidualSources["readVia"] = "direct";
  let snapshotDir: string | undefined;
  try {
    graph = await openReadOnly(paths.graphDb);
  } catch (error) {
    if (!isLockContention(error) || paths.physicalCollectionName === undefined) throw error;
    snapshotDir = mkdtempSync(join(tmpdir(), "residual-probe-"));
    try {
      graph = await openReadOnly(
        await exportThroughDaemon(paths.physicalCollectionName, snapshotDir, resolveBuildDir(options.buildDir)),
      );
    } catch (exportError) {
      rmSync(snapshotDir, { recursive: true, force: true });
      throw exportError;
    }
    readVia = "daemon-snapshot";
  }
  let verdicts: DuckDbGraphSession | undefined;
  try {
    verdicts = paths.verdictDb ? await openReadOnly(paths.verdictDb) : undefined;
  } catch (error) {
    await graph.close();
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    if (isLockContention(error)) {
      throw new Error(
        `verdict store ${paths.verdictDb} is held by a running index / resolve pass; snapshot after it ends`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  return {
    paths,
    graph,
    ...(verdicts ? { verdicts } : {}),
    readVia,
    close: async () => {
      await graph.close();
      await verdicts?.close();
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    },
  };
}
