/**
 * The one declaration of how each run-global map of `CodegraphRunState`
 * survives an incremental run (bd tea-rags-mcp-39xca.6).
 *
 * Pass-2 resolves against a PROJECT-wide symbol table, so a map it reads
 * run-globally is only as wide as what fills it. A `"hydrate"` map is persisted
 * in the `cg_pass1_aggregates` slice and absorbed at `seal` for every file the
 * run did not walk; a `"batchOnly"` map deliberately describes the batch alone,
 * and says why.
 *
 * Before this registry the choice was made per merge, in three places that had
 * to agree — the slice type, `buildPass1Aggregates` and the seal's hydration —
 * and bd tea-rags-mcp-4yvms is what a parallel merge that touched one of them
 * cost. All three now derive from the `"hydrate"` entries below, and two
 * compile-time checks close the loop:
 *
 *  - `RUN_GLOBAL_MAP_PERSISTENCE satisfies Record<RunGlobalMapField, …>`, where
 *    `RunGlobalMapField` is enumerated from `keyof CodegraphRunState`: a new
 *    public run-state field fails the type check until it is registered here or
 *    named in {@link NON_AGGREGATE_RUN_STATE_FIELDS};
 *  - {@link PASS1_AGGREGATE_SLICE_FIELDS} is typed by the coverage of the
 *    persisted record by the hydrate entries: a `CodegraphPass1FileAggregates`
 *    field no hydrate entry owns empties that type and fails the check.
 *
 * `tests/…/run-global-map-registry.test.ts` is the runtime half — the pinned
 * policy table, the codec round trip, the persisted key order.
 */

import type { CodegraphPass1FileAggregates } from "../../../../contracts/types/codegraph.js";
import type { CodegraphRunState } from "./run-state.js";

/** A field of the persisted pass-1 slice — every key of the record except its identity. */
export type Pass1AggregateSliceField = Exclude<keyof CodegraphPass1FileAggregates, "relPath" | "language">;

/** Persisted in the pass-1 slice under `sliceField`, and absorbed at `seal` for unwalked files. */
export interface HydratedRunGlobalMap {
  readonly policy: "hydrate";
  readonly sliceField: Pass1AggregateSliceField;
}

/** Deliberately scoped to the batch; `reason` says why it is not persisted. */
export interface BatchOnlyRunGlobalMap {
  readonly policy: "batchOnly";
  readonly reason: string;
}

export type RunGlobalMapPersistence = HydratedRunGlobalMap | BatchOnlyRunGlobalMap;

/** Every public, non-method member of `CodegraphRunState`. */
type RunStateDataField = {
  [K in keyof CodegraphRunState]-?: CodegraphRunState[K] extends (...args: never[]) => unknown ? never : K;
}[keyof CodegraphRunState];

/**
 * Run-state fields that are NOT aggregated from the files a batch walked, so no
 * persistence policy applies to them. The criterion is where the content comes
 * from, not its shape: `schemaSnapshots` is a map, but it is read from the
 * project root whatever the batch holds.
 */
export const NON_AGGREGATE_RUN_STATE_FIELDS = {
  stats: "the resolve tally pass-2 writes; drained per run and persisted as run stats, not as a slice",
  contentHashes: "threaded in from FileSignalOptions for the run; describes files, not a pass-1 aggregate",
  injectedPass1Aggregates: "the hydration SOURCE the main thread read, not a map hydration fills",
  schemaSnapshots: "read from the project root once per run, whatever the batch walked",
  gemfileContent: "read from the project root once per run, whatever the batch walked",
  declaredDependencies: "read from the project's manifests once per run, whatever the batch walked",
  projectRoot: "the root the run indexes, bound at a run-start seam",
  runScope: "the run's identity token; per run by definition",
} as const satisfies Partial<Record<RunStateDataField, string>>;

/** Every run-state field aggregated from walked files — each needs a persistence policy. */
export type RunGlobalMapField = Exclude<RunStateDataField, keyof typeof NON_AGGREGATE_RUN_STATE_FIELDS>;

/**
 * The registry. Hydrate entries come first and in the persisted slice's key
 * order: `buildPass1Aggregates` emits fields in this order, and the row diff
 * compares the JSON column, so reordering them rewrites every row once.
 */
export const RUN_GLOBAL_MAP_PERSISTENCE = {
  ancestors: { policy: "hydrate", sliceField: "classAncestors" },
  prependedAncestors: { policy: "hydrate", sliceField: "classPrependedAncestors" },
  classExtends: { policy: "hydrate", sliceField: "classExtends" },
  compactClasses: { policy: "hydrate", sliceField: "compactDeclaredClasses" },
  inheritanceRows: { policy: "hydrate", sliceField: "inheritanceEdges" },
  selfDispatchMethods: { policy: "hydrate", sliceField: "selfDispatchMethods" },
  structuredReturnTypes: { policy: "hydrate", sliceField: "structuredReturnTypes" },
  returnTypes: { policy: "hydrate", sliceField: "functionReturnTypes" },
  classFieldTypesByClassKey: { policy: "hydrate", sliceField: "classFieldTypesByClassKey" },
  moduleReexports: { policy: "hydrate", sliceField: "moduleReexports" },
  schemaTables: { policy: "hydrate", sliceField: "classSchemaTables" },

  extractedFilesByLanguage: {
    policy: "batchOnly",
    reason: "counts what THIS run walked; a hydrated file is not an extraction and must not be counted",
  },
  extractedRelPathsByLanguage: {
    policy: "batchOnly",
    reason: "the walked set itself: hydration skips these files and the deferred chunk pass maps them",
  },
  mirroredRelPaths: {
    policy: "batchOnly",
    reason: "files another language partition owns and this one walked as mirrors; hydration skips them too",
  },
  includedBy: { policy: "batchOnly", reason: "derived at seal from the hydrated ancestor maps" },
  hierarchyView: { policy: "batchOnly", reason: "derived at seal from the hydrated inheritance rows" },
  selfDispatchTemplates: { policy: "batchOnly", reason: "derived at seal from the hydrated self-dispatch methods" },
  selfInstantiatingClassMethods: {
    policy: "batchOnly",
    reason: "derived at seal from the hydrated self-dispatch methods",
  },
  instantiatedTypes: { policy: "batchOnly", reason: "RTA set; measured zero recovered edges (bd 8qyax, bd 4yvms)" },
  ivarTypes: { policy: "batchOnly", reason: "no type source emits ivar facts yet (bd wr7ku), so unmeasurable" },
  classFieldCallResults: {
    policy: "batchOnly",
    reason: "rides walker 5's unreleased delta; an index without it resolves exactly as before",
  },
  dispatchTables: { policy: "batchOnly", reason: "measured zero recovered edges (bd 8qyax, bd 4yvms)" },
  callbackParams: { policy: "batchOnly", reason: "measured zero recovered edges (bd 8qyax, bd 4yvms)" },
  knownTargetCallArgs: { policy: "batchOnly", reason: "param family; measured zero recovered edges (bd 8qyax)" },
  paramNames: { policy: "batchOnly", reason: "param family; measured zero recovered edges (bd 8qyax)" },
  classFieldParamLinks: { policy: "batchOnly", reason: "param family; measured zero recovered edges (bd 8qyax)" },
  typedClassFields: { policy: "batchOnly", reason: "gate of the param family fold; measured zero (bd 8qyax)" },
  paramTypes: { policy: "batchOnly", reason: "derived at seal from the param family; measured zero (bd 8qyax)" },
  derivedClassFieldTypes: {
    policy: "batchOnly",
    reason: "derived at seal from the param family; measured zero (bd 8qyax)",
  },
} as const satisfies Record<RunGlobalMapField, RunGlobalMapPersistence>;

type RegistryEntry = (typeof RUN_GLOBAL_MAP_PERSISTENCE)[RunGlobalMapField];

/** The run-state maps whose policy is `"hydrate"`. */
export type HydratedRunGlobalMapField = {
  [M in RunGlobalMapField]: (typeof RUN_GLOBAL_MAP_PERSISTENCE)[M] extends { policy: "hydrate" } ? M : never;
}[RunGlobalMapField];

type HydratedSliceField = Extract<RegistryEntry, { policy: "hydrate" }>["sliceField"];

/**
 * The pass-1 aggregate slice as the domain builds and absorbs it: the record's
 * identity plus exactly the fields the hydrate entries name.
 */
export type Pass1AggregateSlice = Pick<CodegraphPass1FileAggregates, "relPath" | "language" | HydratedSliceField>;

/**
 * The slice fields — but only while the hydrate entries cover every field of
 * the persisted record. A record field with no hydrate entry collapses this to
 * `never`, and the non-empty list typed by it stops compiling.
 */
type CoveredSliceField = [Pass1AggregateSliceField] extends [HydratedSliceField] ? HydratedSliceField : never;

function isHydrated(field: RunGlobalMapField): field is HydratedRunGlobalMapField {
  return RUN_GLOBAL_MAP_PERSISTENCE[field].policy === "hydrate";
}

/** The hydrated run-state maps, in registry (= persisted) order. */
export const HYDRATED_RUN_GLOBAL_MAPS: readonly HydratedRunGlobalMapField[] = (
  Object.keys(RUN_GLOBAL_MAP_PERSISTENCE) as RunGlobalMapField[]
).filter(isHydrated);

/** The persisted slice's fields, in the order `buildPass1Aggregates` writes them. */
export const PASS1_AGGREGATE_SLICE_FIELDS: readonly CoveredSliceField[] = HYDRATED_RUN_GLOBAL_MAPS.map(
  (field) => RUN_GLOBAL_MAP_PERSISTENCE[field].sliceField,
);
