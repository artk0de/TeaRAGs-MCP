/**
 * Editing a project's registry env as CONFIGURATION, not as a side effect of an
 * indexing run (bd tea-rags-mcp-5uk75).
 *
 * The edit writes where replay reads (`registryStampOf` in `env-resolution.ts`):
 * general keys into `entry.env` under the CANONICAL spelling of their alias
 * family, with the family's other spellings evicted so no stale sibling can
 * shadow the new value; the identity keys `DEDICATED_FIELD_ENV_KEYS` names into
 * their dedicated `CollectionEntry` fields.
 *
 * Callers validate first (`ProjectRegistryOps#editEnv`): every key here is
 * assumed to be a registry spelling and every value non-empty.
 */

import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { canonicalRegistryEnvKeys, registryEnvGroupMembers } from "./env-groups.js";

/** Keys to set (any registry spelling) and keys to remove (any spelling removes the whole family). */
export interface RegistryEnvEdit {
  set?: Readonly<Record<string, string>>;
  unset?: readonly string[];
}

/**
 * Dedicated-field keys that describe the INDEXED DATA rather than configure the
 * next run: the model that produced the vectors and the Qdrant backend holding
 * them. Only the index run that produced the data may record them — writing
 * one by hand would make the registry lie about the collection it points at
 * (the model guard reads `embeddingModel`; `qdrantUrl` is weighed against
 * `qdrantEmbedded`). Changing either means re-indexing with it exported.
 */
export const INDEX_RECORDED_ENV_KEYS: ReadonlySet<string> = new Set(["EMBEDDING_MODEL", "QDRANT_URL"]);

/**
 * The editable dedicated fields, keyed by canonical env name — the
 * `DEDICATED_FIELD_ENV_KEYS` minus `INDEX_RECORDED_ENV_KEYS`.
 */
const DEDICATED_FIELD_BY_KEY = {
  EMBEDDING_BASE_URL: "embeddingBaseUrl",
  EMBEDDING_FALLBACK_URL: "embeddingFallbackUrl",
  CODEGRAPH_ENABLED: "codegraphEnabled",
} as const;

type DedicatedKey = keyof typeof DEDICATED_FIELD_BY_KEY;

function isDedicatedKey(key: string): key is DedicatedKey {
  return key in DEDICATED_FIELD_BY_KEY;
}

/** Whether a registry spelling resolves to a key the index run alone records. */
export function isIndexRecordedEnvKey(key: string): boolean {
  return canonicalRegistryEnvKeys(key).some((canonical) => INDEX_RECORDED_ENV_KEYS.has(canonical));
}

/** `"true"` / `"1"` / `"false"` / `"0"` → boolean; anything else → undefined. */
export function parseRegistryEnvBoolean(value: string): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * Apply an edit to a general env map: one canonical spelling per family after
 * the edit. Unsets run first, so a key both unset and set ends up set.
 */
export function editRegistryEnv(
  current: Readonly<Record<string, string>>,
  edit: RegistryEnvEdit,
): Record<string, string> {
  const env: Record<string, string> = { ...current };
  for (const key of edit.unset ?? []) {
    for (const member of registryEnvGroupMembers(key)) delete env[member];
  }
  for (const [key, value] of Object.entries(edit.set ?? {})) {
    for (const canonical of canonicalRegistryEnvKeys(key)) {
      for (const sibling of registryEnvGroupMembers(canonical)) {
        if (sibling !== canonical) delete env[sibling];
      }
      env[canonical] = value;
    }
  }
  return env;
}

/**
 * Apply an edit to a whole registry entry — general keys into `env`, identity
 * keys into their dedicated fields. Returns a new entry; the input is untouched.
 *
 * @throws Error (programming error) when handed a key the index run alone
 *   records — `ProjectRegistryOps#editEnv` rejects those as input first.
 */
export function applyRegistryEnvEdit(entry: CollectionEntry, edit: RegistryEnvEdit): CollectionEntry {
  const general: { set: Record<string, string>; unset: string[] } = { set: {}, unset: [] };
  const next: CollectionEntry = { ...entry };
  const dedicatedTouched = new Set<DedicatedKey>();

  for (const key of edit.unset ?? []) {
    assertEditable(key);
    const dedicated = canonicalRegistryEnvKeys(key).find(isDedicatedKey);
    if (dedicated) {
      delete next[DEDICATED_FIELD_BY_KEY[dedicated]];
      dedicatedTouched.add(dedicated);
    } else {
      general.unset.push(key);
    }
  }
  for (const [key, value] of Object.entries(edit.set ?? {})) {
    assertEditable(key);
    const dedicated = canonicalRegistryEnvKeys(key).find(isDedicatedKey);
    if (dedicated === "CODEGRAPH_ENABLED") {
      next.codegraphEnabled = parseRegistryEnvBoolean(value) === true;
      dedicatedTouched.add(dedicated);
    } else if (dedicated) {
      next[DEDICATED_FIELD_BY_KEY[dedicated]] = value;
      dedicatedTouched.add(dedicated);
    } else {
      general.set[key] = value;
    }
  }

  // A dedicated key never belongs in the env map; drop a stray copy so the map
  // and the field cannot disagree.
  general.unset.push(...dedicatedTouched);
  const current = entry.env ?? entry.tuning;
  const touchesMap = Object.keys(general.set).length > 0 || (current !== undefined && general.unset.length > 0);
  if (touchesMap) next.env = editRegistryEnv(current ?? {}, general);
  return next;
}

/**
 * Record an operator's env edit as PINS (`CollectionEntry.operatorPinnedEnvKeys`,
 * bd tea-rags-mcp-y1ynz): the canonical key of every general key set joins the
 * list, every family unset leaves it. Dedicated identity fields are not env
 * pins — they have their own fields. Unsets run first, as in
 * {@link editRegistryEnv}. Returns a new entry; the input is untouched.
 *
 * Kept apart from {@link applyRegistryEnvEdit}, which writes VALUES: the pin
 * list is what tells replay a value is a decision rather than a stamp.
 */
export function applyOperatorEnvPinEdit(entry: CollectionEntry, edit: RegistryEnvEdit): CollectionEntry {
  const pins = new Set(entry.operatorPinnedEnvKeys);
  for (const key of edit.unset ?? []) {
    for (const canonical of canonicalRegistryEnvKeys(key)) pins.delete(canonical);
  }
  for (const key of Object.keys(edit.set ?? {})) {
    for (const canonical of canonicalRegistryEnvKeys(key)) {
      if (!isDedicatedKey(canonical) && !INDEX_RECORDED_ENV_KEYS.has(canonical)) pins.add(canonical);
    }
  }
  return { ...entry, operatorPinnedEnvKeys: [...pins].sort() };
}

function assertEditable(key: string): void {
  if (isIndexRecordedEnvKey(key)) {
    throw new Error(`${key} is recorded by the index run and cannot be edited`);
  }
}
