/**
 * CochangeOps — the read pipeline of `find_co_changed`
 * (bd tea-rags-mcp-l1ot.1) over the temporal co-change sub-graph: validate,
 * read the built `cg_temporal_*` graph once, answer `built:false` when no
 * build has run, rank each requested file's partners.
 *
 * Linkage is never judged here — `readGraph`'s SQL verdict
 * (`structurallyLinked`: file edges, type-only imports, resolved method
 * edges, re-export barrel chains) passes through, and the Wilson strength is
 * the boundary-diagnostics one, so the tool and the silent-coupling detector
 * answer from one vocabulary.
 *
 * `pathExists`, when given by the facade (the addressed project's root), drops
 * a partner whose file is gone from the working tree: the stored graph is only
 * as fresh as its last build, and the builder only runs during indexing.
 */

import type { GraphDbClient, RelPath } from "../../../contracts/types/codegraph.js";
import {
  DEFAULT_COCHANGE_PARTNERS_LIMIT,
  rankCochangePartners,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import { MissingArgumentError } from "../../public/errors.js";
import type { FindCoChangedRequest, FindCoChangedResult } from "../../public/dto/cochange.js";
import { MissingArgumentError } from "../../public/errors.js";
import { normalizeRelativePath } from "./file-import-ops.js";

export class CochangeOps {
  async find(
    graphDb: Pick<GraphDbClient, "readTemporalCochangeGraph">,
    request: FindCoChangedRequest,
    pathExists?: (relPath: RelPath) => boolean,
  ): Promise<FindCoChangedResult> {
    if (request.files.length === 0) throw new MissingArgumentError(["files"]);
    const files = request.files.map(normalizeRelativePath);
    const graph = await graphDb.readTemporalCochangeGraph();
    if (graph.meta === null) return CochangeOps.empty(files);
    return {
      built: true,
      provenance: {
        ...graph.meta,
        mode: graph.meta.sessionGapMinutes === null ? "commit" : "session",
      },
      files: rankCochangePartners(graph, files, request.limit ?? DEFAULT_COCHANGE_PARTNERS_LIMIT, pathExists),
    };
  }

  /** The answer when no co-change graph exists — honest empty, never an error. */
  static empty(files: readonly string[]): FindCoChangedResult {
    return {
      built: false,
      files: [...files].map((relPath) => ({ relPath, inGraph: false, partners: [] })),
    };
  }
}
