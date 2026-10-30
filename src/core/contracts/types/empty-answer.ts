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
  /**
   * The id is defined only in the addressed working tree, and the tree's graph
   * was unavailable this call, so the index graph that answered has no node for
   * it (bd tea-rags-mcp-07b9w). Not absent — retry once the graph is built.
   */
  | "treeOnly"
  /** The id is an indexed TEST chunk; test code is not in the codegraph, so it has no node and no edges. */
  | "testChunk"
  /** Graph node exists, zero edges — a lower bound when the resolve rate is low. */
  | "noEdges"
  /** `relativePath` names no indexed file (graph file scope). */
  | "unknownFile"
  /** `relativePath` names neither an indexed file nor a directory prefix. */
  | "unknownPath"
  /**
   * `relativePath` exists in the working tree but ingest leaves it out (an
   * ignore pattern, an unindexed file type) — read it with the default code
   * read tool; the message names the pattern when one matched.
   */
  | "ignoredPath"
  /** `relativePath` names a file with no symbol chunk (top-level DSL/config) — read it with the default code read tool. */
  | "noSymbols"
  /** `pathPattern` alone matches no indexed point. */
  | "pathPatternMatchesNothing"
  /** Points exist without the filters / preset filter; the filters removed them. */
  | "filteredOut"
  /** Co-change (or, for find_symbol `table:`, the migration corpus) has never been built for this collection. */
  | "notBuilt"
  /** find_symbol `table:<name>`: the migration corpus holds no `change`/`up` operation on that table. */
  | "noTableOperations"
  /** The file has no commit history in the co-change window. */
  | "noHistory"
  /** `list_projects` `project` names no registered alias; suggestions = nearest aliases. */
  | "unknownProject"
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
