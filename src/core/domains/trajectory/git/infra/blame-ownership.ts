import type { BlameLine } from "../../../../adapters/git/types.js";

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

  const counts = new Map<string, number>();
  for (const ln of lines) {
    counts.set(ln.author, (counts.get(ln.author) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topAuthor, topCount] = sorted[0];

  return {
    blameDominantAuthor: topAuthor,
    blameDominantAuthorPct: Math.round((topCount / lines.length) * 100),
    blameAuthors: sorted.slice(0, TOP_AUTHORS_CAP).map(([author]) => author),
    blameContributorCount: counts.size,
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
