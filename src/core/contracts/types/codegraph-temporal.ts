/**
 * Temporal co-change sub-graph (`cg_temporal_*`, bd tea-rags-mcp-x4rpp) — the
 * process-derived second graph of the codegraph family: which files change in
 * the same commit (or the same author session), measured as association rules.
 *
 * The adapter stores and returns these rows; the extractor and every judgement
 * over them live in `domains/trajectory/codegraph/temporal/`.
 *
 * Paths are project-relative (the collection's `relativePath` space), never
 * repo-relative: a project indexed from a monorepo subdirectory sees only its
 * own files, renamed files are attributed to their HEAD path, and files absent
 * from the working tree at build time are dropped.
 */

import type { RelPath } from "./codegraph-symbols.js";

/** One file's occurrence in the admitted co-change bundles — a `cg_temporal_files` row. */
export interface TemporalCochangeFile {
  relPath: RelPath;
  /** Admitted bundles (commits or sessions) that touched the file — the antecedent count of every rule on it. */
  bundleCount: number;
  /** Stored co-change partners after the per-file cap. */
  partnerCount: number;
  /** Unix seconds of the newest admitted bundle touching the file. */
  lastChangedAt: number;
}

/**
 * One undirected co-change pair — a `cg_temporal_edges_cochange` row, stored
 * once with `relPathA < relPathB` (code-point order).
 */
export interface TemporalCochangeEdge {
  relPathA: RelPath;
  relPathB: RelPath;
  /** Admitted bundles touching both files. */
  support: number;
  /** P(B changes | A changes) = support / bundleCount(A). */
  confidenceAB: number;
  /** P(A changes | B changes) = support / bundleCount(B). */
  confidenceBA: number;
  /** support · N / (bundleCount(A) · bundleCount(B)); > 1 = the pair co-changes more than chance. */
  lift: number;
  /** Unix seconds of the newest bundle touching both files. */
  lastCoChangeAt: number;
  /** Up to three commit SHAs of the newest bundles touching both files, newest first. */
  sampleCommits: string[];
}

/**
 * Provenance of the persisted co-change graph — the single `cg_temporal_meta`
 * row. The builder compares `head` + `fingerprint` to decide whether a run must
 * rebuild; the report echoes the rest so a reader knows what was measured.
 */
export interface TemporalCochangeBuildMeta {
  /** HEAD the graph was built at. */
  head: string;
  /**
   * Hash of every input besides HEAD and the clock that shapes the graph: the
   * parameters (window, bundling, caps, algorithm revision), the project's
   * subtree of the repo, and the working tree's deletions of HEAD paths.
   */
  fingerprint: string;
  /** Unix seconds when the build ran. */
  builtAt: number;
  /** Lower bound of the history window, unix seconds. */
  windowSince: number;
  /** Non-merge commits in the window that touched at least one in-scope file. */
  commitCount: number;
  /** Bundles formed from those commits (= commitCount when session bundling is off). */
  bundleCount: number;
  /** Bundles at or below `maxFilesPerBundle` — the universe N every metric is counted over. */
  admittedBundleCount: number;
  /** Adaptive mass-change cut: bundles touching more files than this are dropped. */
  maxFilesPerBundle: number;
  /** Pairs below this support are not stored. */
  minSupport: number;
  /** Per-file storage cap: an edge is kept when it ranks in the top N of either endpoint. */
  maxPartnersPerFile: number;
  /** Author-session gap bundling commits, in minutes; `null` = one bundle per commit. */
  sessionGapMinutes: number | null;
}

/** What one build writes, wholesale. */
export interface TemporalCochangeSnapshot {
  meta: TemporalCochangeBuildMeta;
  files: TemporalCochangeFile[];
  edges: TemporalCochangeEdge[];
}

/** A stored co-change pair plus whether the structural graph links its endpoints. */
export interface TemporalCochangeEdgeWithLinkage extends TemporalCochangeEdge {
  /**
   * A `cg_symbols_edges_file` row or a resolved `cg_symbols_edges_method` row
   * joins the two files, in either direction.
   */
  structurallyLinked: boolean;
}

/** The persisted co-change graph as the boundary diagnostics read it. */
export interface TemporalCochangeGraph {
  /** `null` = no build has run for this collection yet. */
  meta: TemporalCochangeBuildMeta | null;
  edges: TemporalCochangeEdgeWithLinkage[];
}

/**
 * One `cg_temporal_symbol_commits` row (bd tea-rags-mcp-3gz4f): the commits
 * whose hunks touched a symbol's chunk lines inside one file — the chunk
 * walk's offset tracking collapsed from chunk ids to symbols (`#partN`
 * windows unioned into the parent, chunks without a symbolId dropped).
 */
export interface TemporalSymbolCommitRow {
  relPath: RelPath;
  symbolId: string;
  commitShas: string[];
}

/** One flushed file's symbol commit sets — the unit the store replaces. */
export interface TemporalSymbolCommitFileSnapshot {
  relPath: RelPath;
  symbols: { symbolId: string; commitShas: string[] }[];
}

/**
 * Run-scoped handoff from the git chunk walk to the temporal completion hook
 * (bd tea-rags-mcp-3gz4f). The git provider ABSORBS each dispatched batch's
 * per-symbol commit sets on the main thread — the walk thread cannot hold it,
 * and one file's chunks arrive in several batches — and the temporal hook
 * DRAINS it at collection completion, replacing each flushed file's rows.
 * Absorbing a symbol twice unions its sets: the split batches saw disjoint
 * chunks of the same symbol.
 */
export interface TemporalSymbolCommitBuffer {
  absorb: (relPath: RelPath, symbols: ReadonlyMap<string, ReadonlySet<string>>) => void;
  /** Every buffered file snapshot, insertion order; empties the buffer. */
  drainFiles: () => TemporalSymbolCommitFileSnapshot[];
}
