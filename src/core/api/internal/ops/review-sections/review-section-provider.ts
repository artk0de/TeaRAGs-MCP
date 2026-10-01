/**
 * The review-section port (bd tea-rags-mcp-89k7k.1.4, F3): one diff-scoped
 * report behind one id. Sections are independent providers — adding one must
 * not touch the others — and the orchestration (`ReviewChangesOps`) knows them
 * only through this interface: `isBuilt` decides from the build context, `run`
 * answers over the run context. `architecture` is in the id union but no
 * provider ships for it until F3 slice 2; the id being in the type is future
 * vocabulary, while the MCP enum is derived from the live provider registry so
 * asking for a provider-less id fails loud at the boundary.
 *
 * Absence contract: a section's missing substrate is `built: false` with a
 * reason — never an exception, never a silent empty answer; a file the section
 * could not judge is a `notJudged` entry, never a zero.
 */

import type { GraphDbClient, TemporalCochangeGraph } from "../../../../contracts/types/codegraph.js";
import type { ReviewSectionId } from "../../../public/dto/review.js";
import type { DiffScopeRead, DiffScopeRequest } from "../diff-scope-reader.js";
import type { NamingLexiconOps } from "../naming-lexicon-ops.js";

/** The indexed graph reads a review section may perform. */
export type ReviewGraphDb = Pick<GraphDbClient, "readTemporalCochangeGraph" | "readTemporalSymbolCommits">;

/** The naming lexicon operations, as a review section needs them. */
export type ReviewNamingLexicon = Pick<NamingLexiconOps, "getNamingLexicon">;

/**
 * What a section needs to DECIDE whether it can build. Assembled once per
 * review by the orchestration while the codegraph reader is open — the only
 * expensive read here (`temporalCochange`) is performed when a section that
 * may need it was requested.
 */
export interface ReviewSectionBuildContext {
  /** The change under review, as the F0 reader read it. */
  scope: DiffScopeRead;
  /** The acquired indexed-graph reader; `undefined` when the collection has no codegraph database. */
  graphDb: ReviewGraphDb | undefined;
  /**
   * The indexed temporal co-change graph, read once for a review that asked
   * for a section consuming it: `null` = no build has run, `undefined` = not
   * read for this review.
   */
  temporalCochange: TemporalCochangeGraph | null | undefined;
  /** Why the temporal graph could not be read, when it could not. */
  temporalCochangeError: string | undefined;
  /** The naming lexicon operations; `undefined` when not wired (codegraph off). */
  lexiconOps: ReviewNamingLexicon | undefined;
}

/** What a section needs to ANSWER, once it has decided it can build. */
export interface ReviewSectionContext extends ReviewSectionBuildContext {
  /** The request's addressing, forwarded so a section can address the index itself. */
  addressing: { project?: string; collection?: string; path?: string };
  /** The collection the index reads address — never the worktree path. */
  collectionName: string;
  /**
   * The temporal walk's history window (the git trajectory's
   * `chunkMaxAgeMonths`) — the stated limit of every cohesion number.
   */
  windowMonths: number;
  /** The diff request as the caller sent it — what a section that re-reads the diff forwards. */
  diffRequest: DiffScopeRequest;
}

/** One diff-scoped report provider. */
export interface ReviewSectionProvider {
  readonly id: ReviewSectionId;
  /**
   * Decide from the build context; `{ built: false, reason }` when the
   * substrate is missing. Never throws, never reads.
   */
  isBuilt: (context: ReviewSectionBuildContext) => { built: boolean; reason?: string };
  /**
   * Answer over the run context: the section's payload fields (plus its own
   * `notJudged`, which the envelope carries). Called only when `isBuilt`
   * said built — but a provider stays total and may still answer
   * `{ built: false, reason }` for a substrate that failed at run time.
   */
  run: (context: ReviewSectionContext) => Promise<unknown>;
}
