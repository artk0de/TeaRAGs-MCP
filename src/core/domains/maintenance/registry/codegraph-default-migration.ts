/**
 * One-time registry data migration: record the codegraph flag of every entry
 * indexed before codegraph was on by default (bd tea-rags-mcp-2m83f.15).
 *
 * `CODEGRAPH_ENABLED` defaulted to `false` while codegraph was in beta. An entry
 * whose run never recorded `codegraphEnabled` (written before the field existed,
 * or only ever touched by paths that do not stamp it) would resolve to the new
 * default `true` — its next run would build a graph nobody asked for, and drift
 * would demand `--force-enrichments codegraph` first. The migration stamps what
 * the collection actually holds instead: `true` when it carries codegraph data,
 * `false` when it does not. A recorded flag, either value, is left alone.
 *
 * Evidence comes from the INJECTED {@link CodegraphDataProbe}; production passes
 * {@link collectionHoldsCodegraphData}.
 */

import { join } from "node:path";

import { CodegraphDbFiles } from "../../../adapters/duckdb/codegraph-db-files.js";
import { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import type { CollectionEntry, RegistryFileV1 } from "../../../contracts/types/registry.js";
import { REGISTRY_ENV_PIN_MIGRATION_REVISION } from "./env-pin-migration.js";

/** Data revision this migration advances a registry to (`RegistryFileV1.revision`). */
export const REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION = 3;

/** Whether `collectionName`, under the registry's data directory, holds codegraph data. */
export type CodegraphDataProbe = (dataDir: string, collectionName: string) => boolean;

/** An entry the migration recorded as indexed without codegraph. */
export interface RegistryCodegraphKeptOff {
  collectionName: string;
  /** The project alias, or null for an unnamed entry. */
  projectName: string | null;
}

export interface RegistryCodegraphDefaultMigrationOutcome {
  /** The migrated file, stamped with `REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION`. */
  file: RegistryFileV1;
  keptOff: RegistryCodegraphKeptOff[];
}

/** Due once the env-pin migration (revision 2) has run and this one has not. */
export function isRegistryCodegraphDefaultMigrationDue(file: RegistryFileV1): boolean {
  const revision = file.revision ?? 1;
  return revision >= REGISTRY_ENV_PIN_MIGRATION_REVISION && revision < REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION;
}

/**
 * The payload keys the stats cache recorded at index time — the set payload-key
 * drift compares — answer first. A collection with no stats file falls back to a
 * graph database on disk under `<dataDir>/codegraph`.
 */
export function collectionHoldsCodegraphData(dataDir: string, collectionName: string): boolean {
  const payloadFieldKeys = new StatsCache(join(dataDir, "snapshots")).load(collectionName)?.payloadFieldKeys;
  if (payloadFieldKeys !== undefined) return payloadFieldKeys.some((key) => key.startsWith("codegraph."));
  return new CodegraphDbFiles(dataDir).listCollectionDbNames(collectionName).length > 0;
}

/** Pure but for the probe: the migrated file and the entries kept off, or null when not due. */
export function migrateRegistryCodegraphDefault(
  file: RegistryFileV1,
  dataDir: string,
  probe: CodegraphDataProbe,
): RegistryCodegraphDefaultMigrationOutcome | null {
  if (!isRegistryCodegraphDefaultMigrationDue(file)) return null;
  const collections: Record<string, CollectionEntry> = {};
  const keptOff: RegistryCodegraphKeptOff[] = [];
  for (const [key, entry] of Object.entries(file.collections)) {
    if (entry.codegraphEnabled !== undefined) {
      collections[key] = entry;
      continue;
    }
    const codegraphEnabled = probe(dataDir, entry.collectionName);
    collections[key] = { ...entry, codegraphEnabled };
    if (!codegraphEnabled) keptOff.push({ collectionName: entry.collectionName, projectName: entry.name });
  }
  return {
    file: { ...file, revision: REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION, collections },
    keptOff,
  };
}

/** Human-readable report of one migration run: the projects that stay without codegraph. */
export function formatRegistryCodegraphKeptOff(keptOff: readonly RegistryCodegraphKeptOff[]): string {
  if (keptOff.length === 0) return "";
  const names = keptOff.map((kept) => kept.projectName ?? kept.collectionName).join(", ");
  return (
    `[tea-rags] codegraph is now on by default; ${keptOff.length} project${keptOff.length === 1 ? "" : "s"} indexed without it stay${keptOff.length === 1 ? "s" : ""} off (${names})\n` +
    "[tea-rags] turn it on for one with 'tea-rags projects set-env --name <alias> CODEGRAPH_ENABLED=true'\n"
  );
}
