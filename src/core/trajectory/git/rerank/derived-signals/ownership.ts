import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { fileField } from "./helpers.js";

export class OwnershipSignal implements DerivedSignalDescriptor {
  readonly name = "ownership";
  readonly description = "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)";
  readonly sources = ["dominantAuthorPct", "authors"];
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const pct = fileField(rawSignals, "dominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      return pct / 100;
    }
    const authors = fileField(rawSignals, "authors");
    if (Array.isArray(authors) && authors.length > 0) {
      if (authors.length === 1) return 1;
      return 1 / authors.length;
    }
    return 0;
  }
}
