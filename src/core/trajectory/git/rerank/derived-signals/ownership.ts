import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { fileField } from "./helpers.js";

export class OwnershipSignal implements DerivedSignalDescriptor {
  readonly name = "ownership";
  readonly description = "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)";
  readonly sources = ["dominantAuthorPct", "authors"];
  readonly needsConfidence = true;
  readonly confidenceField = "commitCount";
  extract(payload: Record<string, unknown>): number {
    const pct = fileField(payload, "dominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      return pct / 100;
    }
    const authors = fileField(payload, "authors");
    if (Array.isArray(authors) && authors.length > 0) {
      if (authors.length === 1) return 1;
      return 1 / authors.length;
    }
    return 0;
  }
}
