import type { BlameLine } from "../../../../adapters/vcs/types.js";
import { tallyAuthors } from "./author-identity.js";

export interface BlameOwnership {
  blameDominantAuthor: string;
  blameDominantAuthorPct: number;
  blameAuthors: string[];
  blameContributorCount: number;
}

export interface ChunkRange {
  chunkId: string;
  startLine: number;
  endLine: number;
}

export interface BlameOwnershipResult {
  file: BlameOwnership;
  chunks: Map<string, BlameOwnership>;
}

const TOP_AUTHORS_CAP = 10;

function unknownOwnership(): BlameOwnership {
  return {
    blameDominantAuthor: "unknown",
    blameDominantAuthorPct: 0,
    blameAuthors: [],
    blameContributorCount: 0,
  };
}

function aggregate(lines: BlameLine[]): BlameOwnership {
  if (lines.length === 0) return unknownOwnership();

  // One identity per (mailmap-applied) email — see `author-identity.ts`.
  const tally = tallyAuthors(lines);
  const [top] = tally;

  return {
    blameDominantAuthor: top.name,
    blameDominantAuthorPct: Math.round((top.count / lines.length) * 100),
    blameAuthors: tally.slice(0, TOP_AUTHORS_CAP).map((t) => t.name),
    blameContributorCount: tally.length,
  };
}

/**
 * Aggregate per-line blame attributions into ownership signals at file and
 * (optionally) chunk granularity. The same blame pass feeds both levels —
 * chunk ownership is computed by filtering blame lines whose `lineNumber`
 * falls inside the chunk's `[startLine, endLine]` range.
 */
export function computeBlameOwnership(
  blameLines: BlameLine[],
  chunkRanges?: readonly ChunkRange[],
): BlameOwnershipResult {
  const file = aggregate(blameLines);
  const chunks = new Map<string, BlameOwnership>();

  if (chunkRanges) {
    for (const range of chunkRanges) {
      const chunkLines = blameLines.filter((ln) => ln.lineNumber >= range.startLine && ln.lineNumber <= range.endLine);
      chunks.set(range.chunkId, aggregate(chunkLines));
    }
  }

  return { file, chunks };
}
