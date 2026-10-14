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
 * Every op compiles against the BASE partition, and a file is relabelled by at
 * most one op: the ops of one call are one hypothesis, not a sequence.
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

/** Accumulates one hypothesis's relabel across its ops. */
class RestructureCompiler {
  private readonly components: ReadonlySet<string>;
  private readonly occupiedRelPaths: Set<RelPath>;
  private readonly renamedFrom = new Map<RelPath, RelPath>();
  private readonly componentOf = new Map<RelPath, string>();
  private readonly relabelledBy = new Map<RelPath, number>();
  private readonly addedFiles: ArchitectureRestructureEdgeEdits["addedFiles"] = [];
  private readonly addedRelPaths = new Set<RelPath>();
  private readonly addedEdges: ArchitectureRestructureEdgeEdits["addedEdges"] = [];
  private readonly addedEdgeKeys = new Set<string>();
  private readonly removedEdges = new Set<string>();

  constructor(
    private readonly partition: ArchitectureRestructurePartition,
    private readonly edgeBase: ArchitectureRestructureEdgeBase,
  ) {
    this.components = new Set(partition.componentOf.values());
    this.occupiedRelPaths = new Set(partition.componentOf.keys());
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
    return {
      renamedFrom: this.renamedFrom,
      componentOf: this.componentOf,
      edgeEdits: { addedFiles: this.addedFiles, addedEdges: this.addedEdges, removedEdges: this.removedEdges },
    };
  }

  private addFile(
    { file: relPath, component, abstract }: { file: RelPath; component?: string; abstract?: boolean },
    opIndex: number,
  ): ArchitectureRestructureCompiledOp | CompileFailure {
    if (this.isKnownBasePath(relPath)) return invalid(opIndex, `${relPath} already exists`);
    if (component !== undefined && !this.components.has(component)) {
      return { kind: "unknownComponent", opIndex, component };
    }
    this.addedRelPaths.add(relPath);
    this.occupiedRelPaths.add(relPath);
    this.addedFiles.push({
      relPath,
      ...(component !== undefined ? { component } : {}),
      ...(abstract === true ? { abstract } : {}),
    });
    if (component === undefined) return { op: "addFile", relabelledFiles: 0, components: [], file: relPath };
    this.componentOf.set(relPath, component);
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
    const unknown = files.filter((relPath) => !this.partition.componentOf.has(relPath));
    if (unknown.length > 0) return { kind: "unknownFile", opIndex, files: unknown };
    const target = this.relocationTarget(toComponent, opIndex);
    if (typeof target !== "string") return target;
    const resident = files.find((relPath) => this.partition.componentOf.get(relPath) === toComponent);
    if (resident !== undefined) return invalid(opIndex, `${resident} already belongs to ${toComponent}`);
    const claimed = this.claim(files, opIndex);
    if (claimed) return claimed;
    for (const relPath of files) this.relocate(relPath, toComponent);
    return { op: "move", relabelledFiles: files.length, components: [toComponent] };
  }

  private merge(components: readonly string[], opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    if (new Set(components).size < 2) return invalid(opIndex, "merge needs at least two distinct components");
    const unknown = components.find((component) => !this.components.has(component));
    if (unknown !== undefined) return { kind: "unknownComponent", opIndex, component: unknown };
    const [into, ...folded] = components;
    const target = this.relocationTarget(into, opIndex);
    if (typeof target !== "string") return target;
    const foldedSet = new Set(folded);
    const files = [...this.partition.componentOf].filter(([, c]) => foldedSet.has(c)).map(([relPath]) => relPath);
    const claimed = this.claim(files, opIndex);
    if (claimed) return claimed;
    for (const relPath of files) this.relocate(relPath, into);
    return { op: "merge", relabelledFiles: files.length, components: [into] };
  }

  private split(
    component: string,
    groups: readonly (readonly RelPath[])[],
    opIndex: number,
  ): ArchitectureRestructureCompiledOp | CompileFailure {
    if (!this.components.has(component)) return { kind: "unknownComponent", opIndex, component };
    if (groups.length === 0 || groups.some((group) => group.length === 0)) {
      return invalid(opIndex, "split needs non-empty groups");
    }
    const files = groups.flat();
    const unknown = files.filter((relPath) => !this.partition.componentOf.has(relPath));
    if (unknown.length > 0) return { kind: "unknownFile", opIndex, files: unknown };
    const stranger = files.find((relPath) => this.partition.componentOf.get(relPath) !== component);
    if (stranger !== undefined) return invalid(opIndex, `${stranger} does not belong to ${component}`);
    if (new Set(files).size !== files.length) return invalid(opIndex, "split groups overlap");
    const remainder = [...this.partition.componentOf.values()].filter((c) => c === component).length - files.length;
    if (groups.length + (remainder > 0 ? 1 : 0) < 2) return invalid(opIndex, "a split must leave at least two parts");
    const claimed = this.claim(files, opIndex);
    if (claimed) return claimed;
    const parts = groups.map((group, k) => {
      const part = `${component}~split${k + 1}`;
      for (const relPath of group) this.componentOf.set(relPath, part);
      return part;
    });
    return { op: "split", relabelledFiles: files.length, components: parts };
  }

  /** The directory files relocated into `component` land in, or why there is none. */
  private relocationTarget(component: string, opIndex: number): string | CompileFailure {
    if (!this.components.has(component)) return { kind: "unknownComponent", opIndex, component };
    if (isNamespaceComponent(component)) {
      return invalid(opIndex, `${component} is a constant namespace: its membership is spelled, not a directory`);
    }
    return component;
  }

  /** Mark `files` as this op's; the failure when an earlier op already relabelled one. */
  private claim(files: readonly RelPath[], opIndex: number): CompileFailure | undefined {
    const taken = files.find((relPath) => this.relabelledBy.has(relPath));
    if (taken !== undefined) {
      return invalid(opIndex, `${taken} is already relabelled by op ${this.relabelledBy.get(taken)}`);
    }
    for (const relPath of files) this.relabelledBy.set(relPath, opIndex);
    return undefined;
  }

  private relocate(relPath: RelPath, componentDir: string): void {
    const newPath = this.freePath(componentDir, baseName(relPath));
    this.occupiedRelPaths.add(newPath);
    this.renamedFrom.set(newPath, relPath);
    this.componentOf.set(newPath, componentDir);
  }

  private freePath(componentDir: string, name: string): RelPath {
    const at = (fileName: string) => (componentDir === "" ? fileName : `${componentDir}/${fileName}`);
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
