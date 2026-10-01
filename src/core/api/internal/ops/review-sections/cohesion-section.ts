/**
 * The `cohesion` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): per
 * changed file, the A3 behavioral-cohesion analysis
 * (`analyzeFileCohesion`, bd tea-rags-mcp-3gz4f S1) over the persisted
 * per-symbol commit sets — which symbols of THIS file change together, where
 * the cluster boundary runs, whether the file is a split candidate.
 *
 * Reads are per file (`GraphDbClient#readTemporalSymbolCommits`) — sequential:
 * the client multiplexes by request id, and 200 files is a bounded batch, so
 * v1 keeps the read simple rather than concurrent. A file whose read yields
 * no report is a `notJudged` entry with reason `noCohesionData`: absence is
 * never a zero.
 */

import {
  analyzeFileCohesion,
  type TemporalCohesionReport,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import type { ReviewSectionNotJudgedEntry } from "../../../public/dto/review.js";
import type { ReviewSectionProvider } from "./review-section-provider.js";

/** Reports the section lists; the rest are counted in `truncated`. */
const REPORT_CAP = 50;
/** A file whose analysis returned null — no data to judge, not a zero. */
const NO_COHESION_DATA = "noCohesionData";

export const cohesionSectionProvider: ReviewSectionProvider = {
  id: "cohesion",

  isBuilt: (context) =>
    context.graphDb === undefined
      ? { built: false, reason: "codegraph database unavailable for the addressed collection" }
      : { built: true },

  run: async (context) => {
    const { graphDb } = context;
    if (graphDb === undefined) return { reports: [], analyzedFiles: 0, nullReports: 0 };
    const reports: TemporalCohesionReport[] = [];
    const notJudged: ReviewSectionNotJudgedEntry[] = [];
    for (const relPath of context.scope.files) {
      const snapshot = await graphDb.readTemporalSymbolCommits(relPath);
      const report = analyzeFileCohesion(snapshot, { windowMonths: context.windowMonths });
      if (report === null) {
        notJudged.push({ relPath, reason: NO_COHESION_DATA });
        continue;
      }
      reports.push(report);
    }
    const kept = reports.slice(0, REPORT_CAP);
    return {
      reports: kept,
      analyzedFiles: reports.length,
      nullReports: notJudged.length,
      ...(reports.length > kept.length ? { truncated: reports.length - kept.length } : {}),
      ...(notJudged.length > 0 ? { notJudged } : {}),
    };
  },
};
