/**
 * Reads the inventory `classifyCollectionFootprints` judges — Qdrant, the
 * registry, the codegraph directory, the alias-keyed store files — and the
 * in-use signals that veto a purge, then sizes each finding for the review
 * table. Lives beside `footprint-purge.ts` because it is the read half of the
 * same operation: the fix hands these findings to that purger unchanged.
 *
 * "In use" is read from real signals only — a live indexing lock, a live build
 * lease on the collection, a working-tree overlay directory, a registry path on
 * disk. File mtimes are not one: the embedded Qdrant rewrites every segment on
 * daemon start, so every collection looks freshly touched.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CodegraphDbFiles } from "../core/adapters/duckdb/index.js";
import type { QdrantAliasAccess, QdrantCollectionCatalog, QdrantPointReader } from "../core/adapters/qdrant/ports.js";
import {
  classifyCollectionFootprints,
  CollectionIndexingLock,
  type CollectionRegistry,
  type FootprintFinding,
} from "../core/api/index.js";
import type { PhysicalCollectionName } from "../core/contracts/types/collection-identity.js";
import { physicalCollectionNamesListedByStorage } from "../core/primitives/ids/index.js";

export interface FootprintCensusDeps {
  qdrant: Pick<QdrantCollectionCatalog, "listCollections"> &
    Pick<QdrantAliasAccess, "aliases"> &
    Pick<QdrantPointReader, "getPoint"> & {
      countPoints: (collectionName: string) => Promise<number>;
    };
  registry: Pick<CollectionRegistry, "list">;
  /** `~/.tea-rags` or `$TEA_RAGS_DATA_DIR`. */
  appDataDir: string;
  /** Whether a live run holds the collection's build lease (`ProjectRegistryOps#isCollectionBuildInFlight`). */
  isBuildInFlight: (reader: Pick<QdrantPointReader, "getPoint">, physicalName: string) => Promise<boolean>;
}

export interface FootprintCensusRow extends FootprintFinding {
  /** Chunk count of the Qdrant collection, or null when the row has none. */
  chunks: number | null;
  /** Bytes under the data dir: embedded Qdrant storage, codegraph files, store files. */
  bytesOnDisk: number;
}

const STORE_LOCK_SUFFIX = ".indexing.lock";

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(path: string): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  return listNames(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

/** Store entries in the snapshot dir grouped by the logical name they belong to (`<logical>` or `<logical>.<suffix>`). */
function groupStoreEntries(snapshotDir: string): Map<string, string[]> {
  const byLogical = new Map<string, string[]>();
  for (const entry of listNames(snapshotDir)) {
    const logical = entry.split(".")[0] ?? entry;
    if (logical.length === 0) continue;
    const entries = byLogical.get(logical) ?? [];
    entries.push(entry);
    byLogical.set(logical, entries);
  }
  return byLogical;
}

function listCodegraphGenerations(files: CodegraphDbFiles): PhysicalCollectionName[] {
  const stems = (dir: string, extension: string) =>
    listNames(dir)
      .filter((name) => name.endsWith(extension))
      .map((name) => name.slice(0, -extension.length));
  return physicalCollectionNamesListedByStorage(
    [...new Set([...stems(files.dir, ".duckdb"), ...stems(files.inputSpillDir, ".ndjson")])].sort(),
  );
}

export async function takeFootprintCensus(deps: FootprintCensusDeps): Promise<FootprintCensusRow[]> {
  const { qdrant, appDataDir } = deps;
  const snapshotDir = join(appDataDir, "snapshots");
  const codegraphFiles = new CodegraphDbFiles(appDataDir);
  const physicalCollections = physicalCollectionNamesListedByStorage(await qdrant.listCollections());
  const aliases = await qdrant.aliases.listAliases();
  const storeEntries = groupStoreEntries(snapshotDir);
  const registrations = deps.registry.list().map((entry) => {
    const path = typeof entry.path === "string" ? entry.path : "";
    return {
      collectionName: entry.collectionName,
      name: entry.name,
      path,
      pathExists: path.length > 0 && existsSync(path),
    };
  });

  const inUse = new Map<string, string>();
  for (const logical of listNames(join(appDataDir, "working-tree"))) {
    inUse.set(logical, `working-tree overlay ${join(appDataDir, "working-tree", logical)}`);
  }
  const lock = new CollectionIndexingLock({ lockDir: snapshotDir });
  for (const [logical, entries] of storeEntries) {
    if (!entries.includes(`${logical}${STORE_LOCK_SUFFIX}`)) continue;
    const liveness = await lock.inspectLiveness(logical).catch(() => "alive" as const);
    if (liveness === "alive") inUse.set(logical, "indexing lock held by a live run");
  }
  const reader = { getPoint: qdrant.getPoint.bind(qdrant) };
  for (const physical of physicalCollections) {
    if (await deps.isBuildInFlight(reader, physical).catch(() => true)) inUse.set(physical, "build lease is live");
  }

  const codegraphGenerations = listCodegraphGenerations(codegraphFiles);
  const findings = classifyCollectionFootprints({
    physicalCollections,
    aliases,
    registrations,
    codegraphGenerations,
    storeLogicals: [...storeEntries.keys()],
    inUse,
  });

  const live = new Map<string, (typeof physicalCollections)[number]>(physicalCollections.map((name) => [name, name]));
  const qdrantStorage = join(appDataDir, "qdrant", "collections");
  // Every name sized here was listed by Qdrant or read off the codegraph directory.
  const generationBytes = (name: string): number => {
    const [physical] = physicalCollectionNamesListedByStorage([name]);
    if (physical === undefined) return 0;
    const database = codegraphFiles.pathFor(physical);
    return (
      sizeOf(join(qdrantStorage, physical)) +
      sizeOf(database) +
      sizeOf(`${database}.wal`) +
      sizeOf(codegraphFiles.inputSpillPathFor(physical))
    );
  };
  const generationsOf = (logical: string): string[] =>
    [...new Set([...physicalCollections, ...codegraphGenerations])].filter(
      (name) => name === logical || name.replace(/_v\d+$/, "") === logical,
    );

  return Promise.all(
    findings.map(async (finding) => {
      const { action } = finding;
      const bytesOnDisk =
        action.kind === "generation"
          ? generationBytes(action.physicalName)
          : generationsOf(action.logicalName).reduce((sum, physical) => sum + generationBytes(physical), 0) +
            (storeEntries.get(action.logicalName) ?? []).reduce(
              (sum, entry) => sum + sizeOf(join(snapshotDir, entry)),
              0,
            );
      const physical = finding.physicalName !== null ? live.get(finding.physicalName) : undefined;
      const chunks = physical !== undefined ? await qdrant.countPoints(physical).catch(() => null) : null;
      return { ...finding, chunks, bytesOnDisk };
    }),
  );
}
