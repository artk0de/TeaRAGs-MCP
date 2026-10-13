/**
 * ArchitecturePlannedEdgeOps — `get_architecture_report` planned-edges mode
 * (bd tea-rags-mcp-xb669.2): the write-time dependency-norm verdict for edges
 * a writer is about to add, before they are written.
 *
 * Ledgers come off the INDEXED production graph only, so a planned edge is
 * never its own precedent; roles from the same type rows the report's norms
 * read; locality from the same DOMAIN partition. Read-time, no payload keys.
 *
 * NARROW MODE: only the file graph and the type rows are read — the co-change
 * graph, the member edges and every detector family are skipped, and the
 * response says `detectorFamilies: "notRun"` instead of carrying a partial
 * report. An agent asks this before each new cross-component import, so it
 * pays for the verdict and nothing else.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";
import {
  buildDependencyNormFilePrimaryTypes,
  buildDependencyNormFileRoles,
} from "../../../domains/explore/naming-lexicon/index.js";
import {
  judgePlannedFileEdges,
  type NormPlannedFileEdgeJudgement,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  ARCHITECTURE_PLANNED_EDGE_LIMIT,
  type ArchitecturePlannedEdge,
  type ArchitecturePlannedEdgeVerdict,
  type ArchitecturePlannedEdgeVerdictKind,
  type GetArchitecturePlannedEdgesResponse,
  type GetArchitectureReportRequest,
} from "../../public/dto/architecture.js";
import { InvalidParameterError } from "../../public/errors.js";
import {
  deriveArchitectureComponentFacts,
  readProductionArchitectureGraph,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
} from "./architecture-facts.js";
import { readDependencyNormTypeNameRows, type ArchitectureReportGraphDb } from "./architecture-graph-facts.js";
import { normalizeRelativePath } from "./file-import-ops.js";

/** Report options that shape the detector run — meaningless in planned-edges mode. */
const REPORT_ONLY_OPTIONS = ["pathPattern", "domain", "limit", "layerMap", "knotOf", "offset"] as const;

const VERDICT_OF: Record<
  NonNullable<NormPlannedFileEdgeJudgement["verdict"]>["kind"],
  ArchitecturePlannedEdgeVerdictKind
> = {
  conforms: "CONFORMS",
  misfit: "MISFIT",
  insufficientSupport: "NEW_PATTERN",
};

export class ArchitecturePlannedEdgeOps {
  async judge(
    graphDb: Pick<ArchitectureReportGraphDb, "readFileDependencyGraph" | "readTypeNameRows">,
    request: GetArchitectureReportRequest,
    readIndexedFileImports?: IndexedFileImportLookup,
    readDeclaredTestDependencies?: DeclaredTestDependencyLookup,
  ): Promise<GetArchitecturePlannedEdgesResponse> {
    const planned = validatePlannedEdges(request);
    const production = await readProductionArchitectureGraph(
      graphDb,
      readIndexedFileImports,
      readDeclaredTestDependencies,
    );
    const rows = await readDependencyNormTypeNameRows(graphDb);
    const { components } = deriveArchitectureComponentFacts(production.graph);
    const judgements = judgePlannedFileEdges(
      {
        graph: production.graph,
        fileRoles: buildDependencyNormFileRoles(rows),
        filePrimaryTypes: buildDependencyNormFilePrimaryTypes(rows),
        componentOf: components.componentOf,
      },
      planned.map((edge) => ({
        sourceRelPath: normalizeRelativePath(edge.source),
        targetRelPath: normalizeRelativePath(edge.target),
        ...(edge.reference !== undefined ? { reference: edge.reference } : {}),
      })),
      { isNonProduction: (relPath: RelPath) => production.nonProduction.ignores(relPath) },
    );
    return plannedEdgesResponse(judgements.map(toPlannedEdgeVerdict));
  }

  /** Every planned edge UNJUDGED `noCodegraph` — the answer when no graph can be read. */
  static unavailable(request: GetArchitectureReportRequest): GetArchitecturePlannedEdgesResponse {
    return plannedEdgesResponse(
      validatePlannedEdges(request).map((edge) => ({
        source: normalizeRelativePath(edge.source),
        target: normalizeRelativePath(edge.target),
        verdict: "UNJUDGED",
        reason: "noCodegraph",
      })),
    );
  }
}

function plannedEdgesResponse(
  plannedEdgeVerdicts: ArchitecturePlannedEdgeVerdict[],
): GetArchitecturePlannedEdgesResponse {
  return { mode: "plannedEdges", detectorFamilies: "notRun", plannedEdgeVerdicts };
}

function validatePlannedEdges(request: GetArchitectureReportRequest): readonly ArchitecturePlannedEdge[] {
  const planned = request.plannedEdges ?? [];
  if (planned.length === 0) throw new InvalidParameterError("plannedEdges", "name at least one {source, target}");
  if (planned.length > ARCHITECTURE_PLANNED_EDGE_LIMIT) {
    throw new InvalidParameterError(
      "plannedEdges",
      `at most ${ARCHITECTURE_PLANNED_EDGE_LIMIT} per call, got ${planned.length}`,
    );
  }
  const riding = REPORT_ONLY_OPTIONS.filter((option) => request[option] !== undefined);
  if (riding.length > 0) {
    throw new InvalidParameterError(
      "plannedEdges",
      `planned-edges mode runs no detector family; drop ${riding.join(", ")}`,
    );
  }
  return planned;
}

function toPlannedEdgeVerdict(judgement: NormPlannedFileEdgeJudgement): ArchitecturePlannedEdgeVerdict {
  const { planned, roleSrc, roleDst, family, locality, verdict, transit } = judgement;
  const endpoints = {
    source: planned.sourceRelPath,
    target: planned.targetRelPath,
    ...(roleSrc !== undefined ? { roleSrc } : {}),
    ...(roleDst !== undefined ? { roleDst } : {}),
  };
  if (verdict === undefined || roleSrc === undefined || roleDst === undefined) {
    return {
      ...endpoints,
      verdict: "UNJUDGED",
      ...(family !== undefined ? { family } : {}),
      ...(judgement.unjudgedReason !== undefined ? { reason: judgement.unjudgedReason } : {}),
    };
  }
  const { establishedDirection } = verdict;
  const expectedPath = {
    ...(establishedDirection ? { established: { ...establishedDirection } } : {}),
    ...(transit
      ? {
          transit: {
            roles: [roleSrc, transit.viaRole, roleDst] as [string, string, string],
            supportIn: transit.supportIn,
            supportOut: transit.supportOut,
          },
        }
      : {}),
  };
  return {
    ...endpoints,
    verdict: VERDICT_OF[verdict.kind],
    ...(family !== undefined ? { family } : {}),
    ...(locality !== undefined ? { locality } : {}),
    pairSupport: verdict.pairSupport,
    ...(judgement.reverseSupport !== undefined ? { reverseSupport: judgement.reverseSupport } : {}),
    pValue: verdict.pValue,
    ...(Object.keys(expectedPath).length > 0 ? { expectedPath } : {}),
    ...(judgement.exclusionsUnchecked ? { exclusionsUnchecked: [...judgement.exclusionsUnchecked] } : {}),
  };
}
