/**
 * Why a read tool answered empty (agent turn economy N6). An empty answer that
 * does not say why is read as "tea-rags does not know this" and sends the agent
 * to the shell; the codes separate the four states an empty list conflates —
 * absent, addressed wrongly, graph incomplete, filtered out.
 *
 * Each tool's own op decides the reason: it is domain knowledge (the graph, the
 * filter set, the path index), never something a generic response layer can
 * infer.
 */
export type EmptyAnswerReason =
  /** Symbol id absent from the index / graph (after the `#`↔`.` swap was tried). */
  | "unknownSymbol"
  /** A bare name matched more symbols than one answer carries. */
  | "ambiguous"
  /** Graph node exists, zero edges — a lower bound when the resolve rate is low. */
  | "noEdges"
  /** `relativePath` names no indexed file (graph file scope). */
  | "unknownFile"
  /** `relativePath` names neither an indexed file nor a directory prefix. */
  | "unknownPath"
  /** `pathPattern` alone matches no indexed point. */
  | "pathPatternMatchesNothing"
  /** Points exist without the filters / preset filter; the filters removed them. */
  | "filteredOut"
  /** Co-change has never been built for this collection. */
  | "notBuilt"
  /** The file has no commit history in the co-change window. */
  | "noHistory"
  /** Nothing matched and no narrower reason applies. */
  | "noMatch"
  /**
   * A paging call's `reportId` names no held report the current tree and
   * scope still match — evicted, expired, or judged before the tree moved.
   */
  | "reportStale";

export interface EmptyAnswerExplanation {
  reason: EmptyAnswerReason;
  /** One sentence the agent can act on. */
  message: string;
  /** At most five concrete alternatives (ids, paths, filter names) to try next. */
  suggestions?: string[];
}
