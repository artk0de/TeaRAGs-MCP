/**
 * Direct ancestors on find_symbol class outlines (bd tea-rags-mcp-82cot).
 *
 * Outlines are built from the Qdrant payload, which carries no hierarchy; it
 * lives in the codegraph (`cg_symbols_inheritance`). Rendering stays a pure
 * function of its chunks, so — as for declared visibility
 * (`renderWithDeclaredVisibility`) — a RECORDING render collects the containers
 * the renderer actually outlined, and one batched codegraph read answers
 * exactly those. Nothing outlined (a method body, a doc section) → no read.
 *
 * Unlike visibility this returns the LOOKUP rather than the second render, so
 * the caller composes it into the one render visibility drives — the hierarchy
 * is read once per answer, never once per visibility pass.
 *
 * No resolver (codegraph off), a read that throws (graph unreadable), or no
 * ancestor at all → `undefined`: the outline goes out as it renders today.
 */

import type { ContainerAncestorResolver, InheritanceEdge } from "../../contracts/types/codegraph.js";
import type { WorkingTreeGraphReader } from "../../contracts/types/working-tree.js";
import type { ContainerAncestorLookup } from "./chunk-grouping/types.js";

export async function lookupContainerAncestors(
  render: (ancestorsOf: ContainerAncestorLookup) => unknown,
  resolver: ContainerAncestorResolver | undefined,
  collectionName: string,
  readTreeGraph?: WorkingTreeGraphReader,
): Promise<ContainerAncestorLookup | undefined> {
  if (resolver === undefined) return undefined;
  const requested = new Set<string>();
  render((containerSymbolId) => {
    requested.add(containerSymbolId);
    return undefined;
  });
  if (requested.size === 0) return undefined;
  let edges: InheritanceEdge[];
  try {
    edges = readTreeGraph
      ? await resolver.resolveContainerAncestors(collectionName, [...requested], readTreeGraph)
      : await resolver.resolveContainerAncestors(collectionName, [...requested]);
  } catch {
    return undefined;
  }
  if (edges.length === 0) return undefined;
  const bySource = new Map<string, InheritanceEdge[]>();
  for (const edge of edges) {
    const list = bySource.get(edge.sourceFqName);
    if (list) list.push(edge);
    else bySource.set(edge.sourceFqName, [edge]);
  }
  return (containerSymbolId) => bySource.get(containerSymbolId);
}
