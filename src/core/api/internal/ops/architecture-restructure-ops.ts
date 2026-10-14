/**
 * ArchitectureRestructureOps — `get_architecture_report` restructure mode (bd
 * tea-rags-mcp-r8hme.21): what a hypothetical move / merge / split does to the
 * architecture violations, before anyone moves a file.
 *
 * The 89k7k.1.7 mechanism with a relabel in place of an edge overlay: the
 * graph facts are read ONCE, the ops compile against the base component
 * partition (`compileArchitectureRestructure`), the full detector set judges
 * the base facts and the relabelled facts (`ArchitectureReportOps#judge`,
 * uncapped on both sides — a capped side fabricates deltas), and
 * `measureArchitectureViolationDelta` diffs the two by violation key with the
 * relabel's renames as its rename map, so a moved file's file-keyed
 * violations match their base selves instead of reading resolved + introduced.
 * Component-keyed violations key by component name and move with the
 * partition — that is the delta the hypothesis is asked about.
 *
 * Both runs share one maintenance-signal read (renamed for the relabelled
 * side), so history differs between them only through the relabel. The
 * asset-import specifier read is left out of both, as in the review run.
 *
 * Edge ops (bd tea-rags-mcp-cm9gt.1) compile against the base file edges read
 * here, so a `removeEdge` of a pair the graph does not hold fails instead of
 * simulating nothing. `throwArchitectureRestructureCompileFailure` is the one
 * failure → typed-error mapping every restructure runner shares.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";
import {
  applyArchitectureRestructure,
  architectureRestructureEdgeKey,
  compileArchitectureRestructure,
  type ArchitectureRestructureCompilation,
  type ArchitectureRestructureEdgeBase,
  type ArchitectureRestructurePartition,
  type ArchitectureRestructureRelabel,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  ARCHITECTURE_RESTRUCTURE_OP_LIMIT,
  type ArchitectureRestructureDelta,
  type GetArchitectureReportRequest,
  type GetArchitectureRestructureResponse,
} from "../../public/dto/architecture.js";
import type { ArchitectureChangeSubject } from "../../public/dto/review.js";
import {
  InvalidParameterError,
  UnknownRestructureComponentError,
  UnknownRestructureEdgeError,
  UnknownRestructureFileError,
} from "../../public/errors.js";
import {
  deriveArchitectureComponentFacts,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
  type TreeFileTextLookup,
} from "./architecture-facts.js";
import {
  readArchitectureGraphFacts,
  type ArchitectureGraphFacts,
  type ArchitectureReportGraphDb,
} from "./architecture-graph-facts.js";
import type { GitFileMaintenanceSignalLookup } from "./architecture-maintenance-cost.js";
import { ArchitectureReportOps, readOnce } from "./architecture-report-ops.js";
import {
  measureArchitectureViolationDelta,
  resolvedChangeSubjects,
  violationChangeSubject,
} from "./architecture-violation-delta.js";

/** Report options that shape a report view — meaningless for a delta. `limit` caps the listed subjects instead. */
export const REPORT_ONLY_OPTIONS = [
  "pathPattern",
  "domain",
  "norms",
  "changeReasons",
  "layerMap",
  "knotOf",
  "offset",
  "plannedEdges",
] as const;

export const DEFAULT_SUBJECT_LIMIT = 50;

/** The reads a restructure simulation takes besides the graph DB. */
export interface ArchitectureRestructureLookups {
  readIndexedFileImports?: IndexedFileImportLookup;
  readDeclaredTestDependencies?: DeclaredTestDependencyLookup;
  readTreeFileText?: TreeFileTextLookup;
  readFileMaintenanceSignals?: GitFileMaintenanceSignalLookup;
  /** Codegraph `transitiveImpact` of the named files — a restructure plan's blast radius. Absent: every file reads 0. */
  readFileTransitiveImpacts?: FileTransitiveImpactLookup;
}

/** Each named file's codegraph transitive impact; a file the codegraph has no reading for is omitted. */
export type FileTransitiveImpactLookup = (relPaths: readonly RelPath[]) => Promise<ReadonlyMap<RelPath, number>>;

export class ArchitectureRestructureOps {
  private readonly report = new ArchitectureReportOps();

  async simulate(
    graphDb: ArchitectureReportGraphDb,
    request: GetArchitectureReportRequest,
    lookups: ArchitectureRestructureLookups = {},
  ): Promise<GetArchitectureRestructureResponse> {
    const ops = validateRestructureRequest(request);
    const facts = await readArchitectureGraphFacts(
      graphDb,
      {},
      lookups.readIndexedFileImports,
      lookups.readDeclaredTestDependencies,
      lookups.readTreeFileText,
    );
    const { partition, edgeBase } = deriveArchitectureRestructureBase(facts);
    const compilation = compileArchitectureRestructure(ops, partition, edgeBase);
    if (compilation.kind !== "compiled") throwArchitectureRestructureCompileFailure(compilation);
    const { relabel } = compilation;
    const baseSignals = lookups.readFileMaintenanceSignals && readOnce(lookups.readFileMaintenanceSignals);
    const uncapped = { limit: Number.POSITIVE_INFINITY };
    const [base, relabelled] = await Promise.all([
      this.report.judge(facts, uncapped, { readFileMaintenanceSignals: baseSignals }),
      this.report.judge(applyArchitectureRestructure(facts, relabel), uncapped, {
        readFileMaintenanceSignals: baseSignals && relabelledSignals(baseSignals, relabel),
      }),
    ]);
    const delta = measureArchitectureViolationDelta(base.violations, relabelled.violations, relabel.renamedFrom);
    const introduced = [...delta.introduced].map(([key, violation]) => violationChangeSubject(key, violation));
    const resolved = resolvedChangeSubjects(delta);
    return {
      mode: "restructure",
      hypothesis: compilation.ops,
      delta: restructureDelta(introduced, resolved, delta.persisting.size, request.limit ?? DEFAULT_SUBJECT_LIMIT),
    };
  }

  /** The mode's answer when no codegraph can be read: nothing simulated, nothing compiled. */
  static unavailable(request: GetArchitectureReportRequest): GetArchitectureRestructureResponse {
    validateRestructureRequest(request);
    return { mode: "restructure", hypothesis: [], unavailable: "noCodegraph" };
  }
}

/** What every restructure op compiles against: the base component partition and the base file edges. */
export function deriveArchitectureRestructureBase(facts: ArchitectureGraphFacts): {
  partition: ArchitectureRestructurePartition;
  edgeBase: ArchitectureRestructureEdgeBase;
} {
  const { components } = deriveArchitectureComponentFacts(facts.production.graph);
  return {
    partition: { componentOf: components.componentOf },
    edgeBase: {
      fileEdges: new Set(
        facts.production.graph.edges.map((edge) =>
          architectureRestructureEdgeKey(edge.sourceRelPath, edge.targetRelPath),
        ),
      ),
    },
  };
}

/** The typed input error a failed compile answers with — every failure names its op index. */
export function throwArchitectureRestructureCompileFailure(
  compilation: Exclude<ArchitectureRestructureCompilation, { kind: "compiled" }>,
): never {
  switch (compilation.kind) {
    case "unknownFile":
      throw new UnknownRestructureFileError(compilation.files, compilation.opIndex);
    case "unknownComponent":
      throw new UnknownRestructureComponentError(compilation.component, compilation.opIndex);
    case "unknownEdge":
      throw new UnknownRestructureEdgeError(compilation.from, compilation.to, compilation.opIndex);
    case "invalidOp":
      throw new InvalidParameterError(`restructure[${compilation.opIndex}]`, compilation.detail);
  }
}

function validateRestructureRequest(request: GetArchitectureReportRequest) {
  const ops = request.restructure ?? [];
  if (ops.length === 0) {
    throw new InvalidParameterError(
      "restructure",
      "name at least one op (move, merge, split, addFile, addEdge, removeEdge)",
    );
  }
  if (ops.length > ARCHITECTURE_RESTRUCTURE_OP_LIMIT) {
    throw new InvalidParameterError(
      "restructure",
      `at most ${ARCHITECTURE_RESTRUCTURE_OP_LIMIT} ops per call (one hypothesis), got ${ops.length}`,
    );
  }
  const riding = [...REPORT_ONLY_OPTIONS, "restructurePlan" as const].filter((option) => request[option] !== undefined);
  if (riding.length > 0) {
    throw new InvalidParameterError(
      "restructure",
      `restructure mode answers a delta, not a report; drop ${riding.join(", ")}`,
    );
  }
  return ops;
}

/** The base read keyed by the relabelled paths — a moved file keeps its history. */
export function relabelledSignals(
  baseSignals: GitFileMaintenanceSignalLookup,
  relabel: ArchitectureRestructureRelabel,
): GitFileMaintenanceSignalLookup {
  const renamedTo = new Map<RelPath, RelPath>([...relabel.renamedFrom].map(([newPath, oldPath]) => [oldPath, newPath]));
  return async () =>
    new Map([...(await baseSignals())].map(([relPath, signals]) => [renamedTo.get(relPath) ?? relPath, signals]));
}

export function restructureDelta(
  introduced: ArchitectureChangeSubject[],
  resolved: ArchitectureChangeSubject[],
  persistingCount: number,
  limit: number,
): ArchitectureRestructureDelta {
  const byFamily: ArchitectureRestructureDelta["byFamily"] = {};
  const tally = (subjects: readonly ArchitectureChangeSubject[], side: "introduced" | "resolved") => {
    for (const { family } of subjects) {
      const counts = (byFamily[family] ??= { introduced: 0, resolved: 0 });
      counts[side]++;
    }
  };
  tally(introduced, "introduced");
  tally(resolved, "resolved");
  return {
    introducedCount: introduced.length,
    resolvedCount: resolved.length,
    persistingCount,
    net: introduced.length - resolved.length,
    byFamily,
    introduced: introduced.slice(0, limit),
    resolved: resolved.slice(0, limit),
  };
}
