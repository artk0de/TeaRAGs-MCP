/**
 * The payload keys a filter can condition on (bd tea-rags-mcp-18xh5).
 *
 * Learned by RUNNING the builders a query runs — each typed
 * `FilterDescriptor#toCondition`, probed at every payload level, and
 * `compileFilterPreset` over each filter preset — then walking the Qdrant
 * conditions they emit. The declared payload index set is built from this, so
 * a filter key has an index for the same reason it is filtered on, not because
 * a list beside the builders remembered it.
 */

import type { FilterPresetDef } from "../../contracts/types/filter-preset.js";
import type { FilterDescriptor, FilterLevel } from "../../contracts/types/provider.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { compileFilterPreset } from "./filter-presets/compiler.js";

/**
 * The type of the value a condition matches a key against: an exact
 * `match.value` string or boolean, or a `match.any` over strings. A range, a
 * text match or an `is_empty` guard reports `undefined` — a range serves a
 * count and a timestamp alike, so it does not say how the value is stored.
 */
export type FilterMatchedType = Extract<PayloadSignalDescriptor["type"], "string" | "boolean" | "string[]"> | undefined;

/** Levels a level-aware descriptor is probed at; `undefined` = its own default. */
const PROBE_LEVELS: readonly (FilterLevel | undefined)[] = [undefined, "file", "chunk"];

/** A representative value per descriptor type, for a descriptor that declares no `values`. */
const PROBE_VALUE_BY_TYPE: Readonly<Record<FilterDescriptor["type"], unknown>> = {
  string: "probe",
  number: 1,
  boolean: true,
  "string[]": ["probe"],
};

function matchedType(match: unknown): FilterMatchedType {
  if (match === null || typeof match !== "object") return undefined;
  const { value, any } = match as { value?: unknown; any?: unknown };
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(any) && any.every((item) => typeof item === "string")) return "string[]";
  return undefined;
}

function record(keys: Map<string, FilterMatchedType>, key: string, type: FilterMatchedType): void {
  if (!keys.has(key) || keys.get(key) === undefined) keys.set(key, type);
}

function collect(node: unknown, keys: Map<string, FilterMatchedType>): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keys);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const condition = node as Record<string, unknown>;
  if (typeof condition.key === "string") record(keys, condition.key, matchedType(condition.match));
  const isEmpty = condition.is_empty as { key?: unknown } | undefined;
  if (typeof isEmpty?.key === "string") record(keys, isEmpty.key, undefined);
  for (const clause of ["must", "must_not", "should"]) collect(condition[clause], keys);
}

/**
 * Every physical payload key the given filters and filter presets can emit a
 * condition on, with the type of the value it is matched against.
 *
 * A descriptor is probed with its declared `values` (an enumerated param emits
 * a condition only for some of them) or else one representative value of its
 * type — every registered filter's key is value-independent apart from those
 * enumerations. A preset is compiled without collection stats: a percentile
 * threshold falls back to its literal, the keys are the same.
 */
export function filterPayloadKeys(
  filters: readonly FilterDescriptor[],
  presets: readonly FilterPresetDef[],
): Map<string, FilterMatchedType> {
  const keys = new Map<string, FilterMatchedType>();
  for (const filter of filters) {
    const values = filter.values ?? [PROBE_VALUE_BY_TYPE[filter.type]];
    for (const level of PROBE_LEVELS) {
      for (const value of values) collect(filter.toCondition(value, level), keys);
    }
  }
  for (const preset of presets) collect(compileFilterPreset(preset, undefined, "chunk"), keys);
  return keys;
}
