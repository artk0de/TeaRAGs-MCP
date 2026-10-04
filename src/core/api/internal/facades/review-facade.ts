/**
 * ReviewFacade (bd tea-rags-mcp-89k7k.1.4, F3 slice 1) — thin orchestrator per
 * `.claude/rules/facade-discipline.md`: validate input, delegate to
 * `ReviewChangesOps`. The orchestration (selection, diff read, reader
 * lifecycle, section assembly) lives in the ops; this facade exists so the
 * `App` method has its composition-root shape like every other tool family.
 */

import type { ReviewChangesRequest, ReviewChangesResult } from "../../public/dto/review.js";
import { InvalidParameterError } from "../../public/errors.js";
import type { ReviewChangesOps } from "../ops/review-changes-ops.js";

export interface ReviewFacadeDeps {
  ops: Pick<ReviewChangesOps, "reviewChanges">;
}

export class ReviewFacade {
  constructor(private readonly deps: ReviewFacadeDeps) {}

  async reviewChanges(req: ReviewChangesRequest): Promise<ReviewChangesResult> {
    validateReviewChangesRequest(req);
    return this.deps.ops.reviewChanges(req);
  }
}

/**
 * Shape rules the zod boundary already enforces and a direct API caller must
 * not slip past: an empty `sections` allowlist and an empty `files` list are
 * caller bugs (default-all omits the param), not "review nothing".
 */
export function validateReviewChangesRequest(req: ReviewChangesRequest): void {
  if (req.sections?.length === 0) {
    throw new InvalidParameterError(
      "sections",
      "omit `sections` for every registered section — an empty allowlist reviews nothing",
    );
  }
  if (req.files?.length === 0) {
    throw new InvalidParameterError(
      "files",
      "`files` must name at least one file — omit it to review the whole change",
    );
  }
}
