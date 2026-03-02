import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { confidenceDampening, fileField, fileNum } from "./helpers.js";

export class OwnershipSignal implements DerivedSignalDescriptor {
  readonly name = "ownership";
  readonly description = "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)";
  readonly sources = ["dominantAuthorPct", "authors"];
  private static readonly FALLBACK_THRESHOLD = 5;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    let value: number;
    const pct = fileField(rawSignals, "dominantAuthorPct");
    if (typeof pct === "number" && pct > 0) {
      value = pct / 100;
    } else {
      const authors = fileField(rawSignals, "authors");
      if (Array.isArray(authors) && authors.length > 0) {
        value = authors.length === 1 ? 1 : 1 / authors.length;
      } else {
        return 0;
      }
    }
    const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
    const k = stats?.percentiles?.[25] ?? OwnershipSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
