/**
 * Empty `get_callers` / `get_callees` symbol answers explain themselves (agent
 * turn economy N6, bd tea-rags-mcp-wrosj). An empty edge list used to conflate
 * three states — the graph holds no such node, the id was addressed with the
 * wrong member separator, the node exists with no edges — and an agent that
 * cannot tell them apart re-checks every empty answer with grep.
 *
 * - Wrong separator: `Class.method` for an instance method (or the reverse)
 *   has no node, the swapped id does → the swapped id is ANSWERED and named in
 *   `resolvedSymbolId`; the trap disappears instead of being explained.
 * - No node under either separator → `unknownSymbol`, suggestions = ids defined
 *   under the same short name.
 * - Node, no edges → `noEdges`; when the node's language resolves under
 *   {@link LOW_RESOLVE_RATE} of its call sites the message calls the answer a
 *   lower bound.
 *
 * Every read here runs only after the direct read came back empty. A failing
 * diagnostic read never fails the answer: the explanation, or the part of it
 * the read would have supplied, is left out instead.
 */

import { resolveRateMiss } from "../../../contracts/resolve-rate.js";
import { formatRustcDriverLine } from "../../../contracts/rustc-driver-status.js";
import type { GraphDbClient, ResolveRunStatsRow, SymbolId } from "../../../contracts/types/codegraph.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import { detectLanguage } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { splitMethodSymbol } from "../../../primitives/ids/index.js";

/** Edges read for a symbol target, and the definer id they were read under when it was aliased. */
export interface SymbolEdgeRead<E> {
  edges: E[];
  queriedSymbolId: SymbolId;
  resolvedSymbolId?: SymbolId;
}

export type SymbolEdgeExplanationGraph = Pick<
  GraphDbClient,
  "getSymbolVisibilities" | "lookupSymbolIdsByShortName" | "getRunStats"
> &
  Partial<Pick<GraphDbClient, "getRustcDriverStatus">>;

/** What a lower-bound note tells the agent to do instead of claiming the symbol is unused. */
const LOWER_BOUND_NEXT = "confirm with a literal text search for the name.";

/** Resolve rate under which a zero-edge answer is reported as a lower bound. */
export const LOW_RESOLVE_RATE = 0.9;
const MAX_SUGGESTIONS = 5;

/** Whether an id is an indexed TEST chunk — test code is not walked into the codegraph. */
export type TestChunkProbe = (symbolId: SymbolId) => Promise<boolean>;

/**
 * `readEdges(symbolId)`, and — when it answered empty — the separator-swapped
 * read or the reason it is empty. `edgeNoun` names the edges in the message.
 * A node whose own form has no edges while the other separator form has some
 * (a module function `Registry.client_for` beside an instance `Registry#client_for`)
 * answers the other form, named in `resolvedSymbolId`.
 */
export async function readSymbolEdgesExplained<E>(
  graph: SymbolEdgeExplanationGraph,
  symbolId: SymbolId,
  readEdges: (targetSymbolId: SymbolId) => Promise<SymbolEdgeRead<E>>,
  edgeNoun: "callers" | "callees",
  isTestChunk?: TestChunkProbe,
): Promise<SymbolEdgeRead<E> & { empty?: EmptyAnswerExplanation }> {
  const read = await readEdges(symbolId);
  if (read.edges.length > 0) return read;
  const swapped = swapMemberSeparator(symbolId);
  const queried = read.queriedSymbolId;
  const definitions = await attempt(
    async () => graph.getSymbolVisibilities(swapped && swapped !== queried ? [queried, swapped] : [queried]),
    null,
  );
  if (definitions === null) return read;
  const own = definitions.find((d) => d.symbolId === queried);
  const swappedDefinition = swapped ? definitions.find((d) => d.symbolId === swapped) : undefined;
  if (swapped && swappedDefinition) {
    const swappedRead = await readEdges(swapped);
    const answered = { ...swappedRead, resolvedSymbolId: swappedRead.resolvedSymbolId ?? swapped };
    if (answered.edges.length > 0) return answered;
    if (!own) {
      return {
        ...answered,
        empty: await noEdges(graph, answered.queriedSymbolId, swappedDefinition.relPath, edgeNoun),
      };
    }
  }
  if (own) return { ...read, empty: await noEdges(graph, queried, own.relPath, edgeNoun) };
  return { ...read, empty: await unknownOrTestChunk(graph, symbolId, swapped, isTestChunk) };
}

/** `unknownSymbol`, or `testChunk` when the probe says the id is an indexed test chunk. */
export async function unknownOrTestChunk(
  graph: Pick<SymbolEdgeExplanationGraph, "lookupSymbolIdsByShortName">,
  symbolId: SymbolId,
  swapped: SymbolId | null,
  isTestChunk?: TestChunkProbe,
): Promise<EmptyAnswerExplanation> {
  if (isTestChunk) {
    const ids = swapped ? [symbolId, swapped] : [symbolId];
    for (const id of ids) {
      if (await attempt(async () => isTestChunk(id), false)) {
        return {
          reason: "testChunk",
          message: `${id} is a test chunk — test code is not in the codegraph, so it has no callers or callees.`,
        };
      }
    }
  }
  return unknownSymbol(graph, symbolId, swapped);
}

/** A diagnostic read: its failure (rejection or throw) yields `fallback`, never fails the answer. */
async function attempt<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** `Class.member` ↔ `Class#member` at the last member separator; null for an id without one. */
export function swapMemberSeparator(symbolId: SymbolId): SymbolId | null {
  const split = splitMethodSymbol(symbolId);
  if (!split) return null;
  return `${split.base}${split.sep === "#" ? "." : "#"}${split.member}`;
}

async function noEdges(
  graph: SymbolEdgeExplanationGraph,
  symbolId: SymbolId,
  relPath: string,
  edgeNoun: string,
): Promise<EmptyAnswerExplanation> {
  const message = `${symbolId} is in the codegraph with no ${edgeNoun}.`;
  const language = detectLanguage(relPath);
  const driverNote = language === "rust" ? await attempt(async () => rustcDriverNote(graph), null) : null;
  if (driverNote !== null) return { reason: "noEdges", message: `${message} ${driverNote}` };
  const rate = await attempt(async () => languageResolveRate(graph, language), null);
  if (rate === null || rate >= LOW_RESOLVE_RATE) return { reason: "noEdges", message };
  return {
    reason: "noEdges",
    message:
      `${message} The ${language} resolve rate is ${rate.toFixed(2)}, so this is a lower bound — ` +
      `unresolved call sites may reach it; ${LOWER_BOUND_NEXT}`,
  };
}

/**
 * The rustc-driver note (bd tea-rags-mcp-nknkg.1): a driver that did not index
 * leaves Rust edges static-only. Null when the driver indexed or reported nothing.
 */
async function rustcDriverNote(graph: SymbolEdgeExplanationGraph): Promise<string | null> {
  const record = graph.getRustcDriverStatus ? await graph.getRustcDriverStatus() : null;
  if (!record || record.status.outcome === "indexed") return null;
  return `${formatRustcDriverLine(record.status)} — Rust edges static-only, so this is a lower bound; ${LOWER_BOUND_NEXT}`;
}

/** `resolved / (resolved + resolveRateMiss)` over the language's persisted rows; null when nothing was scored. */
async function languageResolveRate(graph: SymbolEdgeExplanationGraph, language: string): Promise<number | null> {
  const rows = (await graph.getRunStats()).filter((row) => row.language === language);
  if (rows.length === 0) return null;
  const sum = (pick: (row: ResolveRunStatsRow) => number | undefined) =>
    rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const resolved = sum((r) => r.resolved);
  const denominator =
    resolved +
    resolveRateMiss({
      attempted: sum((r) => r.attempted),
      resolved,
      externalSkipped: sum((r) => r.externalSkipped),
      unresolvable: sum((r) => r.unresolvable),
      noInProjectDef: sum((r) => r.noInProjectDef),
      coreAmbiguous: sum((r) => r.coreAmbiguous),
    });
  return denominator === 0 ? null : resolved / denominator;
}

async function unknownSymbol(
  graph: Pick<SymbolEdgeExplanationGraph, "lookupSymbolIdsByShortName">,
  symbolId: SymbolId,
  swapped: SymbolId | null,
): Promise<EmptyAnswerExplanation> {
  const shortName = splitMethodSymbol(symbolId)?.member ?? symbolId;
  const suggestions = await attempt(async () => graph.lookupSymbolIdsByShortName(shortName, MAX_SUGGESTIONS), []);
  const absent = swapped ? `Neither ${symbolId} nor ${swapped} is` : `${symbolId} is not`;
  const next =
    suggestions.length > 0
      ? `suggestions = ids defined under "${shortName}".`
      : "find_symbol with a partial name lists the real ids.";
  return {
    reason: "unknownSymbol",
    message: `${absent} in the codegraph; ${next}`,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}
