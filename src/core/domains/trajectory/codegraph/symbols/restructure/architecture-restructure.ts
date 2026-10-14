/**
 * What-if restructuring (bd tea-rags-mcp-r8hme.21): declarative ops compiled
 * against the report's BASE component partition into a relabel, and the
 * relabel applied to the architecture graph facts. The api judges the base
 * facts and the relabelled facts with the full detector set and diffs the two
 * violation sets by key — this module only builds the relabelled value.
 *
 * A relabel has two halves, and both are needed:
 *
 * - PATHS. A moved file is a file at a new path: the leaking-abstraction
 *   detector, facade aggregation and every module boundary read paths, so a
 *   move into a module makes outside importers deep importers, and a move out
 *   of one stops them being so. `move` and `merge` put a file at
 *   `<target dir>/<base name>`. A name the target already holds, or an entry
 *   file name (`index.ts`, `__init__.py`, …), takes a `~moved` suffix: a
 *   relabel never overwrites a file and never creates or moves a facade.
 * - COMPONENTS. Every relabelled file is pinned to the component the op names
 *   (`componentOf`), which the component partition honours ahead of its own
 *   derivation. A `split` keeps its paths and only relabels: a group carved
 *   out of a module stays inside the module's directory, so only the label can
 *   make it a component. Groups are named `<component>~split<k>` — siblings of
 *   the remainder, never nested in it, because a dependency on a nested
 *   component is containment and SDP does not judge containment.
 *
 * Ops apply IN ORDER (bd tea-rags-mcp-cm9gt): each compiles against the
 * partition the ops before it produced, so a later op may name a component an
 * earlier one produced (merge A+B into A, then merge A+C) and a component an
 * earlier merge folded away is unknown. A file is named by its current path or
 * by its base path — a relocated path never takes a base path, so the two
 * cannot collide. A file's final path and component are the composition of its
 * relabels: a relocated file keeps its BASE name, `renamedFrom` maps the FINAL
 * path to the BASE path, and a file relocated back to its base path carries no
 * rename. A split part is a label, not a directory — nothing relocates into it
 * — and a second split of one component numbers its parts past the first's.
 *
 * EDGE ops (bd tea-rags-mcp-cm9gt.1) model a code remedy — an inversion, an
 * interface extraction, a back-edge cut — that changes edges, not file homes.
 * They name BASE paths (a path is known when the partition holds it or an
 * earlier `addFile` added it), never relabel, and never claim a file, so they
 * mix freely with `move` / `merge` / `split`. They apply on base paths BEFORE
 * the rename map: a moved endpoint of an added edge moves with it. Only the
 * file dependency graph changes; member edges and co-change history do not.
 */

import type {
  ArchitectureRestructureCompiledOp,
  ArchitectureRestructureOp,
} from "../../../../../contracts/types/architecture-report.js";
import type {
  FileDependencyGraph,
  NonPublicMemberEdge,
  RelPath,
  TemporalCochangeGraph,
} from "../../../../../contracts/types/codegraph.js";
import { isNamespaceComponent, MODULE_ENTRY_FILE_NAMES } from "../../component-geometry/index.js";

/** The base partition ops are named against: which component holds each walked file. */
export interface ArchitectureRestructurePartition {
  componentOf: ReadonlyMap<RelPath, string>;
}

/** A compiled hypothesis: the path renames and the component every relabelled file lands in. */
export interface ArchitectureRestructureRelabel {
  /** New path → base path, for every file the hypothesis moves. */
  renamedFrom: ReadonlyMap<RelPath, RelPath>;
  /** Relabelled path (new path for a moved file) → the component it belongs to. */
  componentOf: ReadonlyMap<RelPath, string>;
  /** The edge ops' edits, on BASE paths — applied before the renames. */
  edgeEdits: ArchitectureRestructureEdgeEdits;
}

/** What the edge ops of one hypothesis add to and drop from the file dependency graph, on base paths. */
export interface ArchitectureRestructureEdgeEdits {
  /** `abstract`: the file declares one abstract type (an extracted interface), else one concrete type. */
  addedFiles: { relPath: RelPath; component?: string; abstract?: true }[];
  addedEdges: { from: RelPath; to: RelPath }[];
  /** {@link architectureRestructureEdgeKey} of every dropped file pair. */
  removedEdges: ReadonlySet<string>;
}

/** The base file edges edge ops are checked against, keyed by `(from, to)`. */
export interface ArchitectureRestructureEdgeBase {
  /** {@link architectureRestructureEdgeKey} of every base file edge. */
  fileEdges: ReadonlySet<string>;
}

/** The identity of a file edge: its `(from, to)` pair. */
export function architectureRestructureEdgeKey(from: RelPath, to: RelPath): string {
  return `${from}\u0000${to}`;
}

/** The compile verdict: the relabel, or the first op that names something the partition lacks or cannot honour. */
export type ArchitectureRestructureCompilation =
  | { kind: "compiled"; relabel: ArchitectureRestructureRelabel; ops: ArchitectureRestructureCompiledOp[] }
  | { kind: "unknownFile"; opIndex: number; files: RelPath[] }
  | { kind: "unknownComponent"; opIndex: number; component: string }
  | { kind: "unknownEdge"; opIndex: number; from: RelPath; to: RelPath }
  | { kind: "invalidOp"; opIndex: number; detail: string };

/** The facts a relabel rewrites: every file-keyed graph fact. The report's facts value carries more; the rest is kept. */
export interface ArchitectureRestructureTargetFacts {
  readonly production: { readonly graph: FileDependencyGraph };
  readonly memberEdges: readonly NonPublicMemberEdge[];
  readonly cochange: TemporalCochangeGraph;
  /** Present on relabelled facts: the component every relabelled file is pinned to. */
  readonly componentRelabel?: ReadonlyMap<RelPath, string>;
}

const ENTRY_FILE_NAMES: ReadonlySet<string> = new Set(Object.values(MODULE_ENTRY_FILE_NAMES).flat());

/** A split part is named `<component>~split<k>` — a label, never a directory. */
const SPLIT_PART_MARKER = "~split";
const SPLIT_PART_PATTERN = new RegExp(`${SPLIT_PART_MARKER}\\d+$`);

type CompileFailure = Exclude<ArchitectureRestructureCompilation, { kind: "compiled" }>;

/**
 * Compile `ops` against the base partition — see the module comment for the
 * rules. `edgeBase` is what `removeEdge` is checked against; without it every
 * `removeEdge` is an unknown edge.
 */
export function compileArchitectureRestructure(
  ops: readonly ArchitectureRestructureOp[],
  partition: ArchitectureRestructurePartition,
  edgeBase: ArchitectureRestructureEdgeBase = { fileEdges: new Set() },
): ArchitectureRestructureCompilation {
  const compiler = new RestructureCompiler(partition, edgeBase);
  const compiledOps: ArchitectureRestructureCompiledOp[] = [];
  for (const [opIndex, op] of ops.entries()) {
    const compiled = compiler.compile(op, opIndex);
    if ("kind" in compiled) return compiled;
    compiledOps.push(compiled);
  }
  return { kind: "compiled", relabel: compiler.relabel(), ops: compiledOps };
}

/**
 * `facts` with every file-keyed fact renamed through the relabel and the
 * component pins attached as `componentRelabel`. Pure: `facts` is never
 * mutated. Class ancestry is keyed by symbol, not path, and is kept.
 */
export function applyArchitectureRestructure<Facts extends ArchitectureRestructureTargetFacts>(
  facts: Facts,
  relabel: ArchitectureRestructureRelabel,
): Facts & { readonly componentRelabel: ReadonlyMap<RelPath, string> } {
  const renamedTo = new Map([...relabel.renamedFrom].map(([newPath, oldPath]) => [oldPath, newPath]));
  const rename = (relPath: RelPath): RelPath => renamedTo.get(relPath) ?? relPath;
  const graph = applyArchitectureRestructureEdgeEdits(facts.production.graph, relabel.edgeEdits);
  const { cochange } = facts;
  return {
    ...facts,
    production: {
      ...facts.production,
      graph: {
        files: graph.files.map((file) => ({
          ...file,
          relPath: rename(file.relPath),
          ...(file.typeHeritage
            ? {
                typeHeritage: file.typeHeritage.map((heritage) => ({
                  ...heritage,
                  supertypes: heritage.supertypes.map((s) => ({
                    ...s,
                    declaringRelPaths: s.declaringRelPaths.map(rename),
                  })),
                })),
              }
            : {}),
        })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          sourceRelPath: rename(edge.sourceRelPath),
          targetRelPath: rename(edge.targetRelPath),
        })),
      },
    },
    memberEdges: facts.memberEdges.map((edge) => ({
      ...edge,
      sourceRelPath: rename(edge.sourceRelPath),
      targetRelPath: rename(edge.targetRelPath),
    })),
    cochange: {
      ...cochange,
      edges: cochange.edges.map((edge) => ({
        ...edge,
        relPathA: rename(edge.relPathA),
        relPathB: rename(edge.relPathB),
      })),
      ...(cochange.bundles
        ? { bundles: new Map([...cochange.bundles].map(([id, files]) => [id, files.map(rename)])) }
        : {}),
      ...(cochange.bundleFileLines
        ? {
            bundleFileLines: new Map(
              [...cochange.bundleFileLines].map(([id, lines]) => [
                id,
                new Map([...lines].map(([relPath, counts]) => [rename(relPath), counts])),
              ]),
            ),
          }
        : {}),
    },
    componentRelabel: relabel.componentOf,
  };
}

/**
 * The base graph with the edge edits applied on base paths: every edge of a
 * removed pair dropped (all its call sites), one file record per added file
 * (the language a graph file of the same extension carries, one symbol, one
 * type — abstract when the op says so, else concrete — and no heritage), one
 * edge of call weight 1 per added edge. The census is what the main-sequence
 * and layering-foundation measurements read abstractness from.
 */
function applyArchitectureRestructureEdgeEdits(
  graph: FileDependencyGraph,
  edgeEdits: ArchitectureRestructureEdgeEdits,
): FileDependencyGraph {
  const { addedFiles, addedEdges, removedEdges } = edgeEdits;
  if (addedFiles.length === 0 && addedEdges.length === 0 && removedEdges.size === 0) return graph;
  const languageByExtension = new Map(graph.files.map((file) => [extensionOf(file.relPath), file.language]));
  return {
    files: [
      ...graph.files,
      ...addedFiles.map(({ relPath, abstract }) => ({
        relPath,
        language: languageByExtension.get(extensionOf(relPath)) ?? "",
        symbolCount: 1,
        typeAbstractness: abstract
          ? { abstractTypeCount: 1, concreteTypeCount: 0 }
          : { abstractTypeCount: 0, concreteTypeCount: 1 },
      })),
    ],
    edges: [
      ...graph.edges.filter(
        (edge) => !removedEdges.has(architectureRestructureEdgeKey(edge.sourceRelPath, edge.targetRelPath)),
      ),
      ...addedEdges.map(({ from, to }) => ({ sourceRelPath: from, targetRelPath: to, callWeight: 1 })),
    ],
  };
}

/** Where one base (or added) file sits after the ops compiled so far. */
interface RestructureFilePlacement {
  relPath: RelPath;
  component: string | undefined;
}

/** Accumulates one hypothesis's relabel across its ops, each op against the partition the earlier ones produced. */
class RestructureCompiler {
  /** File count per component of the current partition. */
  private readonly componentSizes = new Map<string, number>();
  private readonly occupiedRelPaths: Set<RelPath>;
  /** Base (or added) path → its current placement. */
  private readonly placements = new Map<RelPath, RestructureFilePlacement>();
  /** Current path of a relocated file → its base path. */
  private readonly basePathAt = new Map<RelPath, RelPath>();
  /** Base (or added) paths some op relabelled, in first-relabel order. */
  private readonly relabelled = new Set<RelPath>();
  private readonly addedFiles: ArchitectureRestructureEdgeEdits["addedFiles"] = [];
  private readonly addedRelPaths = new Set<RelPath>();
  private readonly addedEdges: ArchitectureRestructureEdgeEdits["addedEdges"] = [];
  private readonly addedEdgeKeys = new Set<string>();
  private readonly removedEdges = new Set<string>();

  constructor(
    private readonly partition: ArchitectureRestructurePartition,
    private readonly edgeBase: ArchitectureRestructureEdgeBase,
  ) {
    this.occupiedRelPaths = new Set(partition.componentOf.keys());
    for (const [relPath, component] of partition.componentOf) this.place(relPath, { relPath, component });
  }

  compile(op: ArchitectureRestructureOp, opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    if ("move" in op) return this.move(op.move.files, op.move.toComponent, opIndex);
    if ("merge" in op) return this.merge(op.merge.components, opIndex);
    if ("split" in op) return this.split(op.split.component, op.split.groups, opIndex);
    if ("addFile" in op) return this.addFile(op.addFile, opIndex);
    if ("addEdge" in op) return this.addEdge(op.addEdge.from, op.addEdge.to, opIndex);
    return this.removeEdge(op.removeEdge.from, op.removeEdge.to, opIndex);
  }

  relabel(): ArchitectureRestructureRelabel {
    const renamedFrom = new Map<RelPath, RelPath>();
    const componentOf = new Map<RelPath, string>();
    for (const basePath of this.relabelled) {
      const { relPath, component } = this.placementOf(basePath);
      if (relPath !== basePath) renamedFrom.set(relPath, basePath);
      if (component !== undefined) componentOf.set(relPath, component);
    }
    return {
      renamedFrom,
      componentOf,
      edgeEdits: { addedFiles: this.addedFiles, addedEdges: this.addedEdges, removedEdges: this.removedEdges },
    };
  }

  private addFile(
    { file: relPath, component, abstract }: { file: RelPath; component?: string; abstract?: boolean },
    opIndex: number,
  ): ArchitectureRestructureCompiledOp | CompileFailure {
    if (this.isKnownBasePath(relPath)) return invalid(opIndex, `${relPath} already exists`);
    if (component !== undefined && !this.componentSizes.has(component)) {
      return { kind: "unknownComponent", opIndex, component };
    }
    this.addedRelPaths.add(relPath);
    this.occupiedRelPaths.add(relPath);
    this.addedFiles.push({
      relPath,
      ...(component !== undefined ? { component } : {}),
      ...(abstract === true ? { abstract } : {}),
    });
    this.place(relPath, { relPath, component });
    if (component === undefined) return { op: "addFile", relabelledFiles: 0, components: [], file: relPath };
    this.relabelled.add(relPath);
    return { op: "addFile", relabelledFiles: 0, components: [component], file: relPath };
  }

  private addEdge(from: RelPath, to: RelPath, opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    const unknown = this.unknownEndpoints(from, to, opIndex);
    if (unknown) return unknown;
    if (from === to) return invalid(opIndex, `an edge needs two files, got ${from} twice`);
    const key = architectureRestructureEdgeKey(from, to);
    if (this.edgeBase.fileEdges.has(key) || this.addedEdgeKeys.has(key)) {
      return invalid(opIndex, `edge already present: ${from} → ${to}`);
    }
    this.addedEdgeKeys.add(key);
    this.addedEdges.push({ from, to });
    return { op: "addEdge", relabelledFiles: 0, components: [], edge: { from, to } };
  }

  private removeEdge(from: RelPath, to: RelPath, opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    const unknown = this.unknownEndpoints(from, to, opIndex);
    if (unknown) return unknown;
    const key = architectureRestructureEdgeKey(from, to);
    if (this.addedEdgeKeys.has(key)) return invalid(opIndex, `${from} → ${to} was added by an earlier op`);
    if (!this.edgeBase.fileEdges.has(key) || this.removedEdges.has(key)) {
      return { kind: "unknownEdge", opIndex, from, to };
    }
    this.removedEdges.add(key);
    return { op: "removeEdge", relabelledFiles: 0, components: [], edge: { from, to } };
  }

  /** A base path the partition holds or an earlier `addFile` added. */
  private isKnownBasePath(relPath: RelPath): boolean {
    return this.partition.componentOf.has(relPath) || this.addedRelPaths.has(relPath);
  }

  private unknownEndpoints(from: RelPath, to: RelPath, opIndex: number): CompileFailure | undefined {
    const unknown = [...new Set([from, to])].filter((relPath) => !this.isKnownBasePath(relPath));
    return unknown.length > 0 ? { kind: "unknownFile", opIndex, files: unknown } : undefined;
  }

  private move(
    files: readonly RelPath[],
    toComponent: string,
    opIndex: number,
  ): ArchitectureRestructureCompiledOp | CompileFailure {
    if (files.length === 0) return invalid(opIndex, "move names no file");
    const resolved = this.resolveFiles(files, opIndex);
    if (!Array.isArray(resolved)) return resolved;
    const target = this.relocationTarget(toComponent, opIndex);
    if (typeof target !== "string") return target;
    const resident = files.find((_, k) => this.placementOf(resolved[k]).component === toComponent);
    if (resident !== undefined) return invalid(opIndex, `${resident} already belongs to ${toComponent}`);
    for (const basePath of resolved) this.relocate(basePath, toComponent);
    return { op: "move", relabelledFiles: files.length, components: [toComponent] };
  }

  private merge(components: readonly string[], opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    if (new Set(components).size < 2) return invalid(opIndex, "merge needs at least two distinct components");
    const unknown = components.find((component) => !this.componentSizes.has(component));
    if (unknown !== undefined) return { kind: "unknownComponent", opIndex, component: unknown };
    const [into, ...folded] = components;
    const target = this.relocationTarget(into, opIndex);
    if (typeof target !== "string") return target;
    const foldedSet = new Set(folded);
    const files = [...this.placements]
      .filter(([, { component }]) => component !== undefined && foldedSet.has(component))
      .map(([basePath]) => basePath);
    for (const basePath of files) this.relocate(basePath, into);
    return { op: "merge", relabelledFiles: files.length, components: [into] };
  }

  private split(
    component: string,
    groups: readonly (readonly RelPath[])[],
    opIndex: number,
  ): ArchitectureRestructureCompiledOp | CompileFailure {
    if (!this.componentSizes.has(component)) return { kind: "unknownComponent", opIndex, component };
    if (groups.length === 0 || groups.some((group) => group.length === 0)) {
      return invalid(opIndex, "split needs non-empty groups");
    }
    const files = groups.flat();
    const resolved = this.resolveFiles(files, opIndex);
    if (!Array.isArray(resolved)) return resolved;
    const stranger = files.find((_, k) => this.placementOf(resolved[k]).component !== component);
    if (stranger !== undefined) return invalid(opIndex, `${stranger} does not belong to ${component}`);
    if (new Set(resolved).size !== resolved.length) return invalid(opIndex, "split groups overlap");
    const remainder = (this.componentSizes.get(component) ?? 0) - resolved.length;
    if (groups.length + (remainder > 0 ? 1 : 0) < 2) return invalid(opIndex, "a split must leave at least two parts");
    const parts = this.freeSplitPartNames(component, groups.length);
    let offset = 0;
    for (const [g, group] of groups.entries()) {
      for (const basePath of resolved.slice(offset, offset + group.length)) {
        this.place(basePath, { relPath: this.placementOf(basePath).relPath, component: parts[g] });
        this.relabelled.add(basePath);
      }
      offset += group.length;
    }
    return { op: "split", relabelledFiles: files.length, components: parts };
  }

  /** `count` part names `<component>~split<k>` no current component holds, smallest k first. */
  private freeSplitPartNames(component: string, count: number): string[] {
    const parts: string[] = [];
    for (let k = 1; parts.length < count; k++) {
      const part = `${component}${SPLIT_PART_MARKER}${k}`;
      if (!this.componentSizes.has(part)) parts.push(part);
    }
    return parts;
  }

  /** The directory files relocated into `component` land in, or why there is none. */
  private relocationTarget(component: string, opIndex: number): string | CompileFailure {
    if (!this.componentSizes.has(component)) return { kind: "unknownComponent", opIndex, component };
    if (isNamespaceComponent(component)) {
      return invalid(opIndex, `${component} is a constant namespace: its membership is spelled, not a directory`);
    }
    if (SPLIT_PART_PATTERN.test(component)) {
      return invalid(opIndex, `${component} is a split part: its membership is a label, not a directory`);
    }
    return component;
  }

  /** The base path of every named file (current or base path), or the unknown names. */
  private resolveFiles(files: readonly RelPath[], opIndex: number): RelPath[] | CompileFailure {
    const resolved = files.map((relPath) => this.basePathAt.get(relPath) ?? relPath);
    const unknown = files.filter((_, k) => !this.placements.has(resolved[k]));
    return unknown.length > 0 ? { kind: "unknownFile", opIndex, files: unknown } : resolved;
  }

  private placementOf(basePath: RelPath): RestructureFilePlacement {
    const placement = this.placements.get(basePath);
    if (placement === undefined) throw new Error(`restructure compiler: no placement for ${basePath}`);
    return placement;
  }

  /** Set `basePath`'s placement, keeping the component sizes and the current-path index in step. */
  private place(basePath: RelPath, placement: RestructureFilePlacement): void {
    const previous = this.placements.get(basePath);
    if (previous !== undefined) {
      if (previous.component !== undefined) {
        const size = (this.componentSizes.get(previous.component) ?? 0) - 1;
        if (size > 0) this.componentSizes.set(previous.component, size);
        else this.componentSizes.delete(previous.component);
      }
      if (previous.relPath !== basePath) {
        this.basePathAt.delete(previous.relPath);
        this.occupiedRelPaths.delete(previous.relPath);
      }
    }
    if (placement.component !== undefined) {
      this.componentSizes.set(placement.component, (this.componentSizes.get(placement.component) ?? 0) + 1);
    }
    if (placement.relPath !== basePath) {
      this.basePathAt.set(placement.relPath, basePath);
      this.occupiedRelPaths.add(placement.relPath);
    }
    this.placements.set(basePath, placement);
  }

  private relocate(basePath: RelPath, componentDir: string): void {
    const relPath = this.freePath(componentDir, baseName(basePath), basePath);
    this.place(basePath, { relPath, component: componentDir });
    this.relabelled.add(basePath);
  }

  /** A free path in `componentDir` for `name`; the file's own base path is always free to it. */
  private freePath(componentDir: string, name: string, basePath: RelPath): RelPath {
    const at = (fileName: string) => (componentDir === "" ? fileName : `${componentDir}/${fileName}`);
    if (at(name) === basePath) return basePath;
    if (!ENTRY_FILE_NAMES.has(name) && !this.occupiedRelPaths.has(at(name))) return at(name);
    const dot = name.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
      const candidate = at(`${stem}~moved${n === 1 ? "" : n}${extension}`);
      if (!this.occupiedRelPaths.has(candidate)) return candidate;
    }
  }
}

function invalid(opIndex: number, detail: string): CompileFailure {
  return { kind: "invalidOp", opIndex, detail };
}

function baseName(relPath: RelPath): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

function extensionOf(relPath: RelPath): string {
  const name = baseName(relPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
