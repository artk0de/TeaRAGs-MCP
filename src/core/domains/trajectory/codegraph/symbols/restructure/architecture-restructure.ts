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
}

/** The compile verdict: the relabel, or the first op that names something the partition lacks or cannot honour. */
export type ArchitectureRestructureCompilation =
  | { kind: "compiled"; relabel: ArchitectureRestructureRelabel; ops: ArchitectureRestructureCompiledOp[] }
  | { kind: "unknownFile"; opIndex: number; files: RelPath[] }
  | { kind: "unknownComponent"; opIndex: number; component: string }
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

/** Compile `ops` against the base partition — see the module comment for the rules. */
export function compileArchitectureRestructure(
  ops: readonly ArchitectureRestructureOp[],
  partition: ArchitectureRestructurePartition,
): ArchitectureRestructureCompilation {
  const compiler = new RestructureCompiler(partition);
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
  const { graph } = facts.production;
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

/** Accumulates one hypothesis's relabel across its ops. */
class RestructureCompiler {
  private readonly components: ReadonlySet<string>;
  private readonly occupiedRelPaths: Set<RelPath>;
  private readonly renamedFrom = new Map<RelPath, RelPath>();
  private readonly componentOf = new Map<RelPath, string>();
  private readonly relabelledBy = new Map<RelPath, number>();

  constructor(private readonly partition: ArchitectureRestructurePartition) {
    this.components = new Set(partition.componentOf.values());
    this.occupiedRelPaths = new Set(partition.componentOf.keys());
  }

  compile(op: ArchitectureRestructureOp, opIndex: number): ArchitectureRestructureCompiledOp | CompileFailure {
    if ("move" in op) return this.move(op.move.files, op.move.toComponent, opIndex);
    if ("merge" in op) return this.merge(op.merge.components, opIndex);
    return this.split(op.split.component, op.split.groups, opIndex);
  }

  relabel(): ArchitectureRestructureRelabel {
    return { renamedFrom: this.renamedFrom, componentOf: this.componentOf };
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
