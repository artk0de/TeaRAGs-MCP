/**
 * What a find_symbol miss offers in place of the id it could not find (bd
 * tea-rags-mcp-m9wrp). An agent that guesses `Client#connection` and gets
 * back same-named symbols of another domain keeps guessing; it stops when the
 * miss says the container exists and lists what the container really holds.
 *
 * - `findContainerMembers` — the address's container resolves (same or nearest
 *   namespace) but the member does not: the container's outline addresses,
 *   capped, names resembling the requested member first. The outline comes from
 *   the same SymbolSearchStrategy a `symbol: <Class>` request takes.
 * - `rankByNamespaceProximity` — no container: same-named ids ordered by how
 *   much namespace (then directory) they share with the address; namesakes
 *   sharing nothing are dropped once a closer one exists.
 *
 * Shared by the batch drill's `missing[]` and the single-symbol `empty`.
 */

import { isUnderOwner, lastNameSegment, qualifiedOwnerOf } from "../../primitives/ids/index.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext } from "./strategies/types.js";

/** At most this many container member ids ride on one miss. */
export const MAX_CONTAINER_MEMBERS = 20;

/** Rows a container probe reads — the outline is one row; namesake containers are a handful. */
const CONTAINER_PROBE_LIMIT = 10;

/** A miss whose container resolved: the member it lacks and the members it has. */
export interface ContainerMemberMiss {
  containerId: string;
  /** The requested member with its separator, as written (`#connection`). */
  member: string;
  /** Capped member ids, names resembling the requested member first. */
  memberIds: string[];
  /** How many members the container's outline lists in total. */
  memberCount: number;
  /** How many of `memberIds` lead because their name resembles the requested member. */
  similarCount: number;
}

/** A same-named id a miss may suggest, with the file it lives in. */
export interface NamesakeCandidate {
  symbolId: string;
  relativePath?: string;
}

type SymbolStrategyFactory = (symbol: string) => SymbolSearchStrategy;

/**
 * The container the address names, when it resolves while the member does not.
 * Probes the container as written, then — for a qualified container the index
 * does not hold — its short name, accepting only the nearest-namespace match.
 */
export async function findContainerMembers(
  address: string,
  strategyFor: SymbolStrategyFactory,
  ctx: ExploreContext,
): Promise<ContainerMemberMiss | undefined> {
  const owner = qualifiedOwnerOf(address);
  if (owner.length === 0) return undefined;
  const member = address.slice(owner.length);
  const tail = lastNameSegment(address);
  for (const probe of new Set([owner, lastNameSegment(owner)])) {
    const container = nearestContainer(owner, await outlinesOf(probe, strategyFor, ctx));
    if (container) {
      const resembles = resemblesMember(tail);
      const similar = container.memberIds.filter(resembles);
      const rest = container.memberIds.filter((id) => !resembles(id));
      return {
        containerId: container.symbolId,
        member,
        memberIds: [...similar, ...rest].slice(0, MAX_CONTAINER_MEMBERS),
        memberCount: container.memberIds.length,
        similarCount: Math.min(similar.length, MAX_CONTAINER_MEMBERS),
      };
    }
  }
  return undefined;
}

/** The miss message naming the container and what its suggestions are. */
export function containerMemberMessage(miss: ContainerMemberMiss): string {
  const shown = miss.memberCount > miss.memberIds.length ? ` (${miss.memberIds.length} of ${miss.memberCount})` : "";
  return `${miss.containerId} has no ${miss.member} — suggestions = its members${shown}${miss.similarCount > 0 ? ", similar names first" : ""}`;
}

/**
 * Namesake ids, closest to the address first: same container, then the longest
 * shared namespace prefix, then shared directory segments. Candidates sharing
 * none of these are dropped when any candidate shares one.
 */
export function rankByNamespaceProximity(address: string, candidates: readonly NamesakeCandidate[]): string[] {
  const owner = qualifiedOwnerOf(address);
  const ownerSegments = segmentsOf(owner);
  const scored = uniqueBySymbolId(candidates).map((candidate) => {
    const candidateOwner = qualifiedOwnerOf(candidate.symbolId);
    const prefix =
      owner.length > 0 && candidateOwner === owner
        ? Number.MAX_SAFE_INTEGER
        : sharedLeadingCount(ownerSegments, segmentsOf(candidateOwner));
    return { symbolId: candidate.symbolId, prefix, dir: sharedDirCount(ownerSegments, candidate.relativePath) };
  });
  const anyClose = scored.some((s) => s.prefix > 0 || s.dir > 0);
  return scored
    .filter((s) => !anyClose || s.prefix > 0 || s.dir > 0)
    .sort((a, b) => b.prefix - a.prefix || b.dir - a.dir)
    .map((s) => s.symbolId);
}

interface ContainerOutline {
  symbolId: string;
  memberIds: string[];
}

/** Outlined rows the probe answers with — a failing probe yields none. */
async function outlinesOf(
  probe: string,
  strategyFor: SymbolStrategyFactory,
  ctx: ExploreContext,
): Promise<ContainerOutline[]> {
  try {
    const rows = await strategyFor(probe).execute({ ...ctx, metaOnly: false, offset: 0, limit: CONTAINER_PROBE_LIMIT });
    return rows.flatMap((row) => {
      const symbolId = row.payload?.symbolId;
      const content = row.payload?.content;
      if (typeof symbolId !== "string" || typeof content !== "string") return [];
      const memberIds = outlineMemberIds(content, symbolId);
      return memberIds.length > 0 ? [{ symbolId, memberIds }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Member ids of a class outline — the inverse of `memberLines` in
 * chunk-grouping/code.ts: one `  <id>` line per member, an optional declared
 * visibility suffix (` (private)`) dropped.
 */
function outlineMemberIds(content: string, containerId: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim().replace(/ \([^)]*\)$/, ""))
    .filter((id) => isUnderOwner(id, containerId));
}

/**
 * The outline the address's container resolves to: its exact id, else one
 * ending in it at a namespace boundary, else a same-named one sharing a leading
 * namespace segment. A tie between two different ids resolves to none.
 */
function nearestContainer(owner: string, outlines: readonly ContainerOutline[]): ContainerOutline | undefined {
  const ownerSegments = segmentsOf(owner);
  const ownerTail = lastNameSegment(owner);
  const ranked = outlines
    .map((outline) => ({ outline, score: containerScore(owner, ownerSegments, ownerTail, outline.symbolId) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best) return undefined;
  if (second?.score === best.score && second.outline.symbolId !== best.outline.symbolId) return undefined;
  return best.outline;
}

function containerScore(owner: string, ownerSegments: string[], ownerTail: string, id: string): number {
  if (id === owner) return 3;
  if (["::", "."].some((separator) => id.endsWith(`${separator}${owner}`))) return 2;
  if (lastNameSegment(id) !== ownerTail) return 0;
  const shared = sharedLeadingCount(ownerSegments, segmentsOf(id));
  return shared > 0 ? shared / (shared + 1) : 0;
}

/** Whether an id's member name resembles `member`: either contains the other, case and `_`/`-` ignored. */
function resemblesMember(member: string): (id: string) => boolean {
  const wanted = normalisedName(member);
  return (id) => {
    const name = normalisedName(lastNameSegment(id));
    return name.length > 0 && (name.includes(wanted) || (name.length >= 3 && wanted.includes(name)));
  };
}

function normalisedName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function segmentsOf(owner: string): string[] {
  return owner.length === 0 ? [] : owner.split(/[#.]|::/);
}

function sharedLeadingCount(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How many of the address's namespace segments name a directory of the candidate's path (`BaseClient` ↔ `base_client`). */
function sharedDirCount(ownerSegments: readonly string[], relativePath: string | undefined): number {
  if (!relativePath) return 0;
  const dirs = new Set(relativePath.split("/").slice(0, -1).map(normalisedName));
  return ownerSegments.filter((segment) => dirs.has(normalisedName(segment))).length;
}

function uniqueBySymbolId(candidates: readonly NamesakeCandidate[]): NamesakeCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.symbolId)) return false;
    seen.add(candidate.symbolId);
    return true;
  });
}
