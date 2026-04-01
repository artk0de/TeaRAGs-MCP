import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

interface HeadingPathEntry {
  depth: number;
  text: string;
}

const MAX_DEPTH = 3;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "with",
  "from",
  "by",
  "as",
  "it",
  "this",
  "that",
]);

/**
 * Heading-query token overlap weighted by heading depth.
 *
 * Purpose: boost markdown chunks when query matches heading text.
 * Higher headings (h1) give more boost than lower (h3).
 * Scoring: max(tokenOverlap × depthWeight) across heading path.
 * Range: 0..1. Internal signal — not shown in overlay.
 */
export class HeadingRelevanceSignal implements DerivedSignalDescriptor {
  readonly name = "headingRelevance";
  readonly description = "Heading-query token overlap weighted by heading depth";
  readonly sources: string[] = [];

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const path = rawSignals.headingPath as HeadingPathEntry[] | undefined;
    if (!path?.length || !ctx?.query) return 0;

    const queryTokens = tokenize(ctx.query);
    if (queryTokens.length === 0) return 0;

    let maxScore = 0;
    for (const entry of path) {
      const headingTokens = tokenize(entry.text);
      const headingSet = new Set(headingTokens);
      const matches = queryTokens.filter((t) => headingSet.has(t)).length;
      const overlap = matches / queryTokens.length;
      const depthWeight = (MAX_DEPTH - entry.depth + 1) / MAX_DEPTH;
      maxScore = Math.max(maxScore, overlap * depthWeight);
    }
    return maxScore;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}
