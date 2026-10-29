/**
 * Container ids roll up their members' edges (bd tea-rags-mcp-znzv3).
 *
 * A call lands on a member (`Router.call`), never on the class or module that
 * declares it, so get_callers / get_callees of a container id used to answer
 * `noEdges` while a member had an exact caller — and an agent asking "is this
 * wired anywhere?" concluded "unused". The rollup folds the edges of every
 * direct member into the container's own read, each labelled with the member
 * it belongs to (`member: ".call"` — the separator plus the member segment,
 * unambiguous under the queried id). Edges between the container's own members
 * (and nested scopes) are internal: they answer nothing about the container's
 * use from outside, so they leave the rows and are only counted.
 */

import type { CalleeEdge, CallerEdge, GraphDbClient, SymbolId } from "../../../contracts/types/codegraph.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { ContainerMemberRollup, ContainerMemberRollupField } from "../../public/dto/graph.js";

/** Members read per container; a class past it rolls up its first members in symbolId order. */
export const CONTAINER_MEMBER_LIMIT = 500;

/** The member an edge was rolled up from, as the separator plus member segment (`#run`, `.call`). */
export interface ContainerMemberLabel {
  member?: string;
}

type ContainerMemberGraph = Pick<GraphDbClient, "getContainerMemberSymbolIds" | "getCallersBulk" | "getCalleesBulk">;

interface ContainerEdgeRead<E> {
  edges: E[];
  queriedSymbolId: SymbolId;
  empty?: EmptyAnswerExplanation;
}

/** The read with member rows among its edges (each carrying {@link ContainerMemberLabel}) and the rollup summary. */
type RolledUpRead<R> = R & ContainerMemberRollupField;

/** Callers of the queried container's members, merged into its own caller read. */
export async function rollUpContainerCallers<R extends ContainerEdgeRead<CallerEdge>>(
  graph: ContainerMemberGraph,
  read: R,
  isVisible: (edge: CallerEdge) => boolean,
): Promise<RolledUpRead<R>> {
  const container = read.queriedSymbolId;
  const members = await readMembers(graph, container);
  if (members.length === 0) return read;
  const byMember = await graph.getCallersBulk(members);
  const seen = new Set<string>();
  const rows: (CallerEdge & ContainerMemberLabel)[] = [];
  let internal = 0;
  for (const memberId of members) {
    const member = memberId.slice(container.length);
    for (const edge of (byMember.get(memberId) ?? []).filter(isVisible)) {
      const key = `${edge.sourceRelPath}\0${edge.sourceSymbolId}\0${member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isInsideContainer(container, edge.sourceSymbolId)) internal += 1;
      else rows.push({ ...edge, member });
    }
  }
  const edges = [...read.edges, ...rows].sort(compareCallerRows);
  return mergedRead(read, edges, { members: members.length, ...(internal > 0 && { internalCallers: internal }) });
}

/** Callees of the queried container's members, merged into its own callee read (member order, then target). */
export async function rollUpContainerCallees<R extends ContainerEdgeRead<CalleeEdge>>(
  graph: ContainerMemberGraph,
  read: R,
  isVisible: (edge: CalleeEdge) => boolean,
): Promise<RolledUpRead<R>> {
  const container = read.queriedSymbolId;
  const members = await readMembers(graph, container);
  if (members.length === 0) return read;
  const byMember = await graph.getCalleesBulk(members);
  const internalTargets = new Set<string>();
  const rows: (CalleeEdge & ContainerMemberLabel)[] = [];
  for (const memberId of members) {
    const member = memberId.slice(container.length);
    for (const edge of (byMember.get(memberId) ?? []).filter(isVisible)) {
      const target = edge.targetSymbolId;
      if (target !== null && isInsideContainer(container, target)) internalTargets.add(`${member}\0${target}`);
      else rows.push({ ...edge, member });
    }
  }
  const internal = internalTargets.size;
  return mergedRead(read, [...read.edges, ...rows], {
    members: members.length,
    ...(internal > 0 && { internalCallees: internal }),
  });
}

/** `{ memberRollup }` when the read was rolled up, `{}` otherwise. */
export function memberRollupField(read: { memberRollup?: ContainerMemberRollup }): {
  memberRollup?: ContainerMemberRollup;
} {
  return read.memberRollup === undefined ? {} : { memberRollup: read.memberRollup };
}

/** A member read that fails leaves the container's own answer standing — the rollup decorates it. */
async function readMembers(graph: ContainerMemberGraph, containerSymbolId: SymbolId): Promise<SymbolId[]> {
  try {
    return await graph.getContainerMemberSymbolIds(containerSymbolId, CONTAINER_MEMBER_LIMIT);
  } catch {
    return [];
  }
}

/** No member row and no own edge keeps the read's empty explanation; any row retires it. */
function mergedRead<R extends ContainerEdgeRead<E>, E>(
  read: R,
  edges: E[],
  memberRollup: ContainerMemberRollup,
): RolledUpRead<R> {
  if (edges.length === 0) return { ...read, memberRollup };
  return { ...read, edges, empty: undefined, memberRollup };
}

/** The container itself, its members, and its nested scopes (`C#m`, `C.m`, `C.Inner#m`, `C::Inner`). */
function isInsideContainer(containerSymbolId: SymbolId, symbolId: SymbolId): boolean {
  return (
    symbolId === containerSymbolId ||
    symbolId.startsWith(`${containerSymbolId}#`) ||
    symbolId.startsWith(`${containerSymbolId}.`) ||
    symbolId.startsWith(`${containerSymbolId}::`)
  );
}

/** The one-hop caller order: source path, source id, then the member (own edges, unlabelled, first). */
function compareCallerRows(a: CallerEdge & ContainerMemberLabel, b: CallerEdge & ContainerMemberLabel): number {
  return (
    compareText(a.sourceRelPath, b.sourceRelPath) ||
    compareText(a.sourceSymbolId, b.sourceSymbolId) ||
    compareText(a.member ?? "", b.member ?? "")
  );
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
