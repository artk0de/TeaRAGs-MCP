import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { classifyComponentRelation } from "./constant-namespace.js";
import { compareCodePoints } from "./layer-graph.js";
import { buildLayeringModel } from "./layering.js";
import type { ComponentGraph, LayeringComponentPosition, LayeringModel } from "./types.js";

/**
 * A read-only view over the inferred layering (bd tea-rags-mcp-89k7k.1.19.3)
 * for a consumer judging edges the model never saw — the diff-scoped
 * `layeringBackEdge` family. Positions and knots are the model's own; the view
 * adds only the two questions a hypothetical NEW component edge asks of the
 * graph the model was built from.
 */
export interface LayeringReading {
  /** The component's level/depth/knot flag; undefined when the component graph does not hold it. */
  positionOf: (component: string) => LayeringComponentPosition | undefined;
  /**
   * The knot an edge `source -> target` would close: every component on a
   * path from `target` back to `source` (both included), sorted. Undefined
   * when `target` never reaches `source` — the edge closes no knot.
   */
  knotClosedBy: (sourceComponent: string, targetComponent: string) => string[] | undefined;
  /**
   * Whether the two components nest — a directory and one inside it, either
   * way. The model's own composition test (`LayeringKnot.composition`) applied
   * to one pair: a module and its own sub-parts, never a layering defect.
   */
  isComposition: (sourceComponent: string, targetComponent: string) => boolean;
  /** The walked files the component holds; empty when it holds none. */
  filesOf: (component: string) => readonly RelPath[];
}

/** The view over `componentGraph`, reading the caller's model when it already built one. */
export function readLayering(
  componentGraph: ComponentGraph,
  model: LayeringModel = buildLayeringModel(componentGraph),
): LayeringReading {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const { sourceComponent, targetComponent } of componentGraph.dependencies) {
    appendTo(outgoing, sourceComponent, targetComponent);
    appendTo(incoming, targetComponent, sourceComponent);
  }
  const files = new Map<string, RelPath[]>();
  for (const [relPath, component] of componentGraph.componentOf) appendTo(files, component, relPath);

  return {
    positionOf: (component) => model.positions.get(component),
    knotClosedBy: (sourceComponent, targetComponent) => {
      if (sourceComponent === targetComponent) return undefined;
      const fromTarget = reachable(targetComponent, outgoing);
      if (!fromTarget.has(sourceComponent)) return undefined;
      const toSource = reachable(sourceComponent, incoming);
      return [...fromTarget].filter((component) => toSource.has(component)).sort(compareCodePoints);
    },
    isComposition: (sourceComponent, targetComponent) => {
      const relation = classifyComponentRelation(sourceComponent, targetComponent);
      return relation === "descendant" || relation === "ancestor";
    },
    filesOf: (component) => files.get(component) ?? [],
  };
}

/** Every component reachable from `start` over `adjacency`, `start` included. */
function reachable(start: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const neighbour of adjacency.get(next) ?? []) {
      if (seen.has(neighbour)) continue;
      seen.add(neighbour);
      queue.push(neighbour);
    }
  }
  return seen;
}

function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
