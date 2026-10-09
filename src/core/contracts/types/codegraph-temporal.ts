/**
 * Temporal co-change sub-graph (`cg_temporal_*`, bd tea-rags-mcp-x4rpp) — the
 * process-derived second graph of the codegraph family: which files change in
 * the same commit, measured as association rules counted once per author burst.
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
  /**
   * Author bursts with an admitted commit touching the file — the antecedent
   * count of every rule on it (bd tea-rags-mcp-3vg0x: a burst counts a file once).
   */
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
  /** Author bursts holding an admitted commit that touched both files. */
  support: number;
  /** P(B changes | A changes) = support / bundleCount(A). */
  confidenceAB: number;
  /** P(A changes | B changes) = support / bundleCount(B). */
  confidenceBA: number;
  /** support · N / (bundleCount(A) · bundleCount(B)); > 1 = the pair co-changes more than chance. */
  lift: number;
  /** Unix seconds of the newest bundle touching both files. */
  lastCoChangeAt: number;
  /** Up to three commit SHAs touching both files, one per burst, newest first. */
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
  /** Bundles formed from those commits — one per commit, so equal to `commitCount`. */
  bundleCount: number;
  /** Commit bundles at or below `maxFilesPerBundle`. */
  admittedBundleCount: number;
  /**
   * Author bursts holding an admitted commit — the universe N every metric is
   * counted over. `null` = a build predating burst dedup (bd tea-rags-mcp-3vg0x).
   */
  admittedBurstCount: number | null;
  /** Adaptive mass-change cut: bundles touching more files than this are dropped. */
  maxFilesPerBundle: number;
  /** Pairs below this support are not stored. */
  minSupport: number;
  /** Per-file storage cap: an edge is kept when it ranks in the top N of either endpoint. */
  maxPartnersPerFile: number;
  /**
   * The burst window W in minutes: consecutive commits of one author identity
   * less than W apart form one burst, inside which a file or a pair counts once.
   * Derived per repository at build time. `null` = a build predating it.
   */
  burstWindowMinutes: number | null;
  /** How W was chosen; `null` = a build predating it. */
  burstWindowMethod: CochangeBurstWindowMethod | null;
}

/**
 * `"estimated"` = the half-life of the excess file-set overlap between
 * consecutive same-author commits; `"fallback"` = too little history to
 * estimate, the fixed fallback window.
 */
export type CochangeBurstWindowMethod = "estimated" | "fallback";

/** What one build writes, wholesale. */
export interface TemporalCochangeSnapshot {
  meta: TemporalCochangeBuildMeta;
  files: TemporalCochangeFile[];
  edges: TemporalCochangeEdge[];
  /**
   * The admitted bundles' file memberships, index = bundle id — the
   * `cg_temporal_bundle_files` rows (bd tea-rags-mcp-c3v6o). Component-level
   * counts the pair table cannot answer: a bundle touching a component
   * through three files still counts once, and pair caps never truncated it.
   */
  bundles: readonly (readonly RelPath[])[];
  /** Each admitted bundle's commit SHAs, aligned with `bundles`; absent = not recorded. */
  bundleCommits?: readonly (readonly string[])[];
  /** Each admitted bundle's author-burst id, aligned with `bundles`; absent = not recorded. */
  bundleBursts?: readonly number[];
  /**
   * The task ids each admitted bundle's commit message names (the git
   * trajectory's `extractTaskIds`), aligned with `bundles`; `[]` = none named,
   * absent = not recorded (bd tea-rags-mcp-09c4m).
   */
  bundleTaskIds?: readonly (readonly string[])[];
  /**
   * The +/- line counts each admitted bundle's commit made to each of its
   * files, aligned with `bundles` and, inside a bundle, with its files; `null`
   * = git reported no count for that file. Absent = not recorded (bd
   * tea-rags-mcp-dm61n).
   */
  bundleFileLines?: readonly (readonly (CochangeFileLineCounts | null)[])[];
  /**
   * Each admitted bundle's commit time in unix seconds, aligned with
   * `bundles`. Absent = not recorded (bd tea-rags-mcp-zf9yz).
   */
  bundleTimestamps?: readonly number[];
}

/** The lines one commit added to and deleted from one file — git's numstat pair (bd tea-rags-mcp-dm61n). */
export interface CochangeFileLineCounts {
  added: number;
  deleted: number;
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
  /**
   * The admitted bundles' file memberships, keyed by bundle id (bd
   * tea-rags-mcp-c3v6o) — the same rows `readTemporalBundleFiles` answers.
   * Absent = the read carries no membership (a fixture, or a daemon from a
   * build before the table existed): absence is silence, never "no bundles"
   * — an empty build reads as an EMPTY map. The store always sets it.
   */
  bundles?: ReadonlyMap<number, readonly RelPath[]>;
  /**
   * The commit SHAs each admitted bundle was formed from, keyed by bundle id
   * (`cg_temporal_bundle_commits`, bd tea-rags-mcp-89k7k.1.14) — what lets a
   * review drop its own commits from the history. Absent or empty = the build
   * predates the table.
   */
  bundleCommits?: ReadonlyMap<number, readonly string[]>;
  /**
   * The author burst each admitted bundle belongs to, keyed by bundle id (bd
   * tea-rags-mcp-3vg0x) — what lets the significance gate count a file or a
   * pair once per burst. Absent or empty = the build predates it; every
   * bundle is then its own burst.
   */
  bundleBursts?: ReadonlyMap<number, number>;
  /**
   * The task ids each admitted bundle's commit message names, keyed by bundle
   * id (bd tea-rags-mcp-09c4m) — what joins one author burst's commits into
   * one logical change for shotgun surgery. A bundle naming none maps to `[]`;
   * absent or empty = the build predates migration 045, and the join falls
   * back to structure alone.
   */
  bundleTaskIds?: ReadonlyMap<number, readonly string[]>;
  /**
   * The +/- line counts each admitted bundle's commit made to its files, keyed
   * by bundle id then by the file's path (bd tea-rags-mcp-dm61n). A file with
   * no recorded count is absent from its bundle's map; absent or empty = the
   * build predates migration 046.
   */
  bundleFileLines?: ReadonlyMap<number, ReadonlyMap<RelPath, CochangeFileLineCounts>>;
  /**
   * Each admitted bundle's commit time in unix seconds, keyed by bundle id (bd
   * tea-rags-mcp-zf9yz) — the chronology; bundle ids are a storage order.
   * Absent or empty = the build predates migration 047.
   */
  bundleTimestamps?: ReadonlyMap<number, number>;
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
