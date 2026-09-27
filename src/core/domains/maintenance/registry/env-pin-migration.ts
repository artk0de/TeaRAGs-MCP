/**
 * One-time registry data migration: drop env pins frozen at release defaults
 * (bd tea-rags-mcp-h4l6k).
 *
 * Before h4l6k every index run pinned its FULL resolved env snapshot — every
 * code default materialized — into `CollectionEntry.env`, so each entry froze
 * the defaults of the release that first indexed it and a later default change
 * reached no project (the BREAKING `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES` 10000 →
 * 5000 applied to none of 21 entries). The run-time fix pins only explicit
 * operator decisions (`buildPinnedRegistryEnvSnapshot`); this migration cleans
 * the stamps already on disk, once.
 *
 * A pin is dropped when its value equals the CURRENT code default for its key,
 * or when it is a known frozen default of an earlier release
 * (`REGISTRY_FROZEN_RELEASE_DEFAULT_PINS`). Everything else — non-default pins,
 * keys outside the default snapshot (backend URLs etc.), every non-env field —
 * is left byte-identical.
 *
 * The code defaults are INJECTED (`RegistryEnvCodeDefaultsProvider`): they come
 * from config parsing in `bootstrap`, which this domain may not import.
 */

import type { CollectionEntry, RegistryFileV1 } from "../../../contracts/types/registry.js";

/** Data revision this migration advances a registry to (`RegistryFileV1.revision`). */
export const REGISTRY_ENV_PIN_MIGRATION_REVISION = 2;

/**
 * Pins that were a code default in an earlier release but no longer are, so the
 * current-default comparison cannot recognize them. `TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES`
 * defaulted to 10000 until 2brzq made it 5000.
 */
export const REGISTRY_FROZEN_RELEASE_DEFAULT_PINS: Readonly<Record<string, readonly string[]>> = {
  TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: ["10000"],
};

/** Canonical env key → the current code default, as `buildRegistryEnvSnapshot` spells it. */
export type RegistryEnvCodeDefaults = Readonly<Record<string, string>>;

/** Lazily computes `RegistryEnvCodeDefaults`; only called when a migration is due. */
export type RegistryEnvCodeDefaultsProvider = () => RegistryEnvCodeDefaults;

export interface RegistryEnvPinDrop {
  collectionName: string;
  /** The project alias, or null for an unnamed entry. */
  projectName: string | null;
  /** Dropped keys, sorted. */
  droppedKeys: string[];
}

export interface RegistryEnvPinMigrationOutcome {
  /** The migrated file, stamped with `REGISTRY_ENV_PIN_MIGRATION_REVISION`. */
  file: RegistryFileV1;
  /** One record per entry that lost at least one pin. */
  droppedPins: RegistryEnvPinDrop[];
}

export function isRegistryEnvPinMigrationDue(file: RegistryFileV1): boolean {
  return (file.revision ?? 1) < REGISTRY_ENV_PIN_MIGRATION_REVISION;
}

function isFrozenDefaultPin(key: string, value: string, codeDefaults: RegistryEnvCodeDefaults): boolean {
  if (Object.hasOwn(codeDefaults, key) && codeDefaults[key] === value) return true;
  return REGISTRY_FROZEN_RELEASE_DEFAULT_PINS[key]?.includes(value) ?? false;
}

/**
 * Pure: returns the migrated file and what was dropped, or null when the file
 * is already at (or past) the migration revision.
 *
 * An env emptied by the migration stays `{}` — an ABSENT env makes replay fall
 * back to the legacy `tuning` stamp (`resolveRegistryEnv`).
 */
export function migrateRegistryEnvPins(
  file: RegistryFileV1,
  codeDefaults: RegistryEnvCodeDefaults,
): RegistryEnvPinMigrationOutcome | null {
  if (!isRegistryEnvPinMigrationDue(file)) return null;
  const collections: Record<string, CollectionEntry> = {};
  const droppedPins: RegistryEnvPinDrop[] = [];
  for (const [key, entry] of Object.entries(file.collections)) {
    if (entry.env === undefined) {
      collections[key] = entry;
      continue;
    }
    const kept: Record<string, string> = {};
    const droppedKeys: string[] = [];
    for (const [envKey, value] of Object.entries(entry.env)) {
      if (isFrozenDefaultPin(envKey, value, codeDefaults)) droppedKeys.push(envKey);
      else kept[envKey] = value;
    }
    if (droppedKeys.length === 0) {
      collections[key] = entry;
      continue;
    }
    collections[key] = { ...entry, env: kept };
    droppedPins.push({
      collectionName: entry.collectionName,
      projectName: entry.name,
      droppedKeys: droppedKeys.sort(),
    });
  }
  return {
    file: { ...file, revision: REGISTRY_ENV_PIN_MIGRATION_REVISION, collections },
    droppedPins,
  };
}

/** Human-readable report of one migration run, one line per affected project. */
export function formatRegistryEnvPinDrops(droppedPins: readonly RegistryEnvPinDrop[]): string {
  if (droppedPins.length === 0) return "";
  const lines = droppedPins.map((drop) => {
    const n = drop.droppedKeys.length;
    return `[tea-rags] registry env migration: ${drop.projectName ?? drop.collectionName}: dropped ${n} pin${n === 1 ? "" : "s"} frozen at release defaults (${drop.droppedKeys.join(", ")})\n`;
  });
  lines.push(
    "[tea-rags] these projects now follow code defaults; re-pin a value deliberately with 'tea-rags projects set-env --name <alias> KEY=VALUE'\n",
  );
  return lines.join("");
}
