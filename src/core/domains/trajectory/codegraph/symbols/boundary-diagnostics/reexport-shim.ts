import { reexportBindingsField, reexportSourceName } from "../../../../../contracts/reexport-bindings.js";
import {
  WHOLE_MODULE_EXPORT_NAME,
  type FileDependencyEdge,
  type FileDependencyGraph,
  type RelPath,
} from "../../../../../contracts/types/codegraph.js";
import { carriesReexport, forwardedExportNames } from "./facade-aggregation.js";
import type { ReexportShimComponents, ReexportShimForward } from "./types.js";

/** What the re-export shim exclusion takes out of SDP judgement, named for a report (bd tea-rags-mcp-ciq4d). */
export const REEXPORT_SHIM_REASON =
  "re-export shim: a component whose every file only re-exports other modules has no volatility of its own - edges into it are judged against the components it re-exports, its own edges are not judged";

/**
 * The components every walked file of which is a PURE RE-EXPORT (bd
 * tea-rags-mcp-ciq4d), and where each such file's re-exports finally land.
 *
 * A file is a pure re-export when the walk found no symbol it defines
 * (`symbolCount` 0), it has at least one outgoing edge, and every outgoing
 * edge forwards exports (`carriesReexport`) and carries no resolved call.
 * One file declaring anything of its own makes its component opaque.
 *
 * A shim file's ULTIMATE targets are the targets of its edges, followed
 * through every file that itself sits in a shim component, to the first file
 * that does not (or that the walk never extracted) — the per-file link. Its
 * FORWARDS keep each edge's names, so an importer can be followed by the
 * names it takes instead (`resolveReexportShimTargets`).
 */
export function deriveReexportShimComponents(
  graph: FileDependencyGraph,
  componentOf: ReadonlyMap<RelPath, string>,
): ReexportShimComponents {
  const outgoing = new Map<RelPath, FileDependencyEdge[]>();
  for (const edge of graph.edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    const edges = outgoing.get(edge.sourceRelPath);
    if (edges) edges.push(edge);
    else outgoing.set(edge.sourceRelPath, [edge]);
  }

  const opaque = new Set<string>();
  const members = new Map<string, RelPath[]>();
  for (const file of graph.files) {
    const component = componentOf.get(file.relPath);
    if (component === undefined) continue;
    const files = members.get(component);
    if (files) files.push(file.relPath);
    else members.set(component, [file.relPath]);
    if (!isPureReexportFile(file.symbolCount, outgoing.get(file.relPath) ?? [])) opaque.add(component);
  }
  const componentDirs = new Set([...members.keys()].filter((c) => !opaque.has(c)));

  const ultimateTargetsOf = new Map<RelPath, RelPath[]>();
  const forwardsOf = new Map<RelPath, ReexportShimForward[]>();
  for (const component of componentDirs) {
    for (const relPath of members.get(component) ?? []) {
      ultimateTargetsOf.set(relPath, ultimateTargets(relPath, outgoing, componentOf, componentDirs));
      forwardsOf.set(
        relPath,
        (outgoing.get(relPath) ?? []).map((e) => ({
          targetRelPath: e.targetRelPath,
          names: forwardedExportNames(e),
          ...reexportBindingsField(e.reexportedExportBindings),
        })),
      );
    }
  }
  return { componentDirs, ultimateTargetsOf, forwardsOf };
}

/** Where an importer edge into a shim file lands, and whether its names settled it. */
export interface ReexportShimResolution {
  targets: readonly RelPath[];
  /** False when the names could not settle the chain and `targets` is the per-file link. */
  nameResolved: boolean;
}

/**
 * The files an importer edge into shim file `relPath` reaches through the
 * shim chain, followed by the names it takes (bd tea-rags-mcp-ciq4d). A
 * forward EXPOSING a taken name carries it on under the name it forwards from
 * its target — the source side of an alias (bd tea-rags-mcp-zl3so); a name no
 * named forward claims passes through every `export *` forward. A namespace
 * import (`*`) takes the whole surface — the per-file link, exactly, and so
 * does a name a forward exposes for its whole target (`export * as ns`).
 *
 * The names cannot settle it — the importer recorded none, or took a name no
 * forward of the chain claims and no `export *` can carry — and the answer is
 * the per-file link with `nameResolved: false`.
 */
export function resolveReexportShimTargets(
  shims: ReexportShimComponents,
  relPath: RelPath,
  importedExportNames: readonly string[] | undefined,
): ReexportShimResolution {
  const perFile = shims.ultimateTargetsOf.get(relPath) ?? [];
  if (!importedExportNames || importedExportNames.length === 0) return { targets: perFile, nameResolved: false };
  if (importedExportNames.includes(WHOLE_MODULE_EXPORT_NAME)) return { targets: perFile, nameResolved: true };
  const targets = new Set<RelPath>();
  const visited = new Set<string>();
  const frontier: { relPath: RelPath; names: ReadonlySet<string> }[] = [
    { relPath, names: new Set(importedExportNames) },
  ];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    const forwards = shims.forwardsOf.get(next.relPath) ?? [];
    const unclaimed = new Set(next.names);
    const carried: { targetRelPath: RelPath; names: ReadonlySet<string> }[] = [];
    for (const forward of forwards) {
      const hit = forward.names.filter((n) => next.names.has(n));
      for (const n of hit) unclaimed.delete(n);
      if (hit.length === 0) continue;
      const forwarded = new Set(hit.map((n) => reexportSourceName(forward, n)));
      // `export * as ns`: the whole target stands behind the taken name.
      if (forwarded.has(WHOLE_MODULE_EXPORT_NAME) && !hit.includes(WHOLE_MODULE_EXPORT_NAME)) {
        for (const target of shims.ultimateTargetsOf.get(forward.targetRelPath) ?? [forward.targetRelPath]) {
          targets.add(target);
        }
        forwarded.delete(WHOLE_MODULE_EXPORT_NAME);
        if (forwarded.size === 0) continue;
      }
      carried.push({ targetRelPath: forward.targetRelPath, names: forwarded });
    }
    if (unclaimed.size > 0) {
      const stars = forwards.filter((f) => f.names.includes(WHOLE_MODULE_EXPORT_NAME));
      if (stars.length === 0) return { targets: perFile, nameResolved: false };
      for (const star of stars) carried.push({ targetRelPath: star.targetRelPath, names: unclaimed });
    }
    for (const step of carried) {
      if (!shims.forwardsOf.has(step.targetRelPath)) {
        targets.add(step.targetRelPath);
        continue;
      }
      const key = `${step.targetRelPath}\u0000${[...step.names].sort().join(",")}`;
      if (visited.has(key)) continue;
      visited.add(key);
      frontier.push({ relPath: step.targetRelPath, names: step.names });
    }
  }
  return { targets: [...targets].sort(compareCodePoints), nameResolved: true };
}

function isPureReexportFile(symbolCount: number, edges: readonly FileDependencyEdge[]): boolean {
  return symbolCount === 0 && edges.length > 0 && edges.every((e) => e.callWeight === 0 && carriesReexport(e));
}

/** Depth-first through shim files, each visited once; sorted, distinct. */
function ultimateTargets(
  relPath: RelPath,
  outgoing: ReadonlyMap<RelPath, readonly FileDependencyEdge[]>,
  componentOf: ReadonlyMap<RelPath, string>,
  shimComponents: ReadonlySet<string>,
): RelPath[] {
  const targets = new Set<RelPath>();
  const visited = new Set<RelPath>([relPath]);
  const frontier: RelPath[] = [relPath];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    for (const edge of outgoing.get(next) ?? []) {
      const target = edge.targetRelPath;
      const component = componentOf.get(target);
      if (component === undefined || !shimComponents.has(component)) targets.add(target);
      else if (!visited.has(target)) {
        visited.add(target);
        frontier.push(target);
      }
    }
  }
  return [...targets].sort(compareCodePoints);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
