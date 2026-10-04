/**
 * Applying the S1→S2 diff to a clone of the tree's previous graph (the SEED,
 * tree state S1) so the result equals the graph built from the base over the
 * whole S2 delta (epic xi2r9). The parent computes the diff
 * (`treeDeltaAgainstSeed`); this module owns what an incremental step must
 * re-derive BEYOND that diff for the equality to hold, and the cases it cannot
 * make equal — those are rejected, and the caller builds from the base.
 *
 * Why more than the diff: the build from the base walks every file of the
 * tree's delta against the current tree, while the seed holds the delta files
 * the edit left alone as they resolved against S1. Such a HELD file re-derives
 * differently only when what it resolves against moved:
 *
 * - it holds an edge (an import or a resolved call) into a file the edit
 *   changes or deletes — re-walked with the diff, in the same run, as the base
 *   build walks them together;
 * - its text names a declaration the edit adds or reshapes — a call that did
 *   not resolve in S1 may resolve now, and an unresolved call leaves no edge to
 *   find it by — re-walked in a second run once the diff's declarations are
 *   known.
 *
 * Files outside the delta hold the base's rows in both graphs, except where the
 * seed's history pruned them: an edge into a declaration or file the seed's
 * delta removed is gone from the seed but present in the base. Re-adding a
 * file the seed deleted, or re-declaring such a symbol on a file the seed
 * changed, while files outside the delta reference it in the base, is
 * therefore rejected, as is deleting a file the seed ADDED while files outside
 * the delta import it (the base build never pruned their edges into a file it
 * never had).
 *
 * So is a diff that walks a file back to BASE content — a revert, or a
 * re-added deletion. The base build does not walk such a file: it keeps the
 * base's rows, pruned where the tree deleted a target. A walk re-resolves them
 * against the tree instead — an import of a file the tree deleted stays as an
 * edge, a call into a changed file resolves anew — and nothing short of the
 * base build reproduces the base's rows.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DuckDbGraphClient } from "../../../../adapters/duckdb/client.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import {
  fileScopedSymbolKey,
  parseFileScopedSymbolKey,
  type SymbolDefinition,
} from "../../../../contracts/types/codegraph-symbols.js";
import {
  deleteThenWalk,
  finishTreeGraph,
  walkTreeFiles,
  type TreeDeltaWalk,
  type TreeGraphClone,
} from "./tree-graph-walk.js";

/** A previously published graph of the same tree, and what takes it to the current tree. Plain data (IPC). */
export interface WorkingTreeGraphSeed {
  /** The seed graph — self-contained like a snapshot; read, cloned, never opened. */
  dbPath: string;
  /** Paths to walk: `treeDeltaAgainstSeed`'s `changedRelPaths`. */
  changedRelPaths: string[];
  /** Paths to delete: `treeDeltaAgainstSeed`'s `deletedRelPaths`. */
  deletedRelPaths: string[];
  /** Files of the current tree's delta the seed already holds at their current content. */
  heldRelPaths: string[];
  /** Paths among `changedRelPaths` that are back at base content: out of the current delta, on disk. */
  restoredRelPaths: string[];
  /** The seed's own delta against the base — where its rows are not the base's. */
  seedChangedRelPaths: string[];
  seedDeletedRelPaths: string[];
}

/** A seeded application that could not be made equal to the base build; the caller builds from the base. */
export interface TreeGraphSeedRejection {
  rejected: string;
}

/**
 * Apply `seed`'s diff to the opened clone of the seed graph. `baseSnapshotPath`
 * is read (READ_ONLY) only when a restore or a deletion needs the base's edges.
 */
export async function applySeedDelta(
  clone: TreeGraphClone,
  seed: WorkingTreeGraphSeed,
  baseSnapshotPath: string,
): Promise<TreeDeltaWalk | TreeGraphSeedRejection> {
  const touched = new Set([...seed.changedRelPaths, ...seed.deletedRelPaths]);
  const base = new BaseGraphProbe(baseSnapshotPath);
  try {
    if (touched.size === 0) {
      await finishTreeGraph(clone);
      return { walkedFileCount: 0, hierarchyDependentCount: 0 };
    }
    if (seed.restoredRelPaths.length > 0) {
      return { rejected: `${seed.restoredRelPaths[0]} is back at base content, whose rows only the base build keeps` };
    }
    const held = new Set(seed.heldRelPaths);
    const inTreeDelta = new Set([...held, ...seed.changedRelPaths]);
    const outsideTreeDelta = (relPath: string): boolean => !inTreeDelta.has(relPath) && !touched.has(relPath);

    const referencing = await edgeSourcesInto(clone.graphDb, touched);
    const seedChanged = new Set(seed.seedChangedRelPaths);
    for (const relPath of seed.deletedRelPaths) {
      if (!seedChanged.has(relPath)) continue;
      // Imports only: a call resolves into a declaration that exists, so the
      // base build never holds one into a file the base never had.
      const outside = [...(referencing.importers.get(relPath) ?? [])].find(outsideTreeDelta);
      if (outside !== undefined && !(await base.holdsFile(relPath))) {
        return {
          rejected: `${relPath}, added by the seed's tree, is deleted while ${outside}, outside the delta, imports it`,
        };
      }
    }

    const before = await declarationsOn(clone.graphDb, touched);
    const heldReferencing = [...sourcesOf(referencing)].filter((relPath) => held.has(relPath) && !touched.has(relPath));
    const { walked, hierarchyDependentCount } = await deleteThenWalk(
      clone,
      seed.changedRelPaths,
      seed.deletedRelPaths,
      heldReferencing,
    );
    const after = await declarationsOn(clone.graphDb, touched);
    const moved = movedDeclarations(before, after);

    const restored = await restoredWithOutsideCallers(seed, moved, base, outsideTreeDelta);
    if (restored) return { rejected: restored };

    const walkedSet = new Set(walked);
    const naming = await filesNaming(
      clone.treeRoot,
      [...held].filter((relPath) => !walkedSet.has(relPath)),
      new Set(moved.map((definition) => definition.shortName)),
    );
    if (naming.length > 0) await walkTreeFiles(clone, naming);
    await finishTreeGraph(clone);
    return { walkedFileCount: walked.length + naming.length, hierarchyDependentCount };
  } finally {
    await base.close();
  }
}

/**
 * What the seed's history pruned and the base build keeps, named; undefined
 * when there is none: a file the seed deleted and the tree holds again, while
 * files outside the delta import it or call into it in the base; a declaration
 * that appears on a file the seed changed, while files outside the delta call
 * it in the base.
 */
async function restoredWithOutsideCallers(
  seed: WorkingTreeGraphSeed,
  moved: readonly MovedDeclaration[],
  base: BaseGraphProbe,
  outsideTreeDelta: (relPath: string) => boolean,
): Promise<string | undefined> {
  const seedDeleted = new Set(seed.seedDeletedRelPaths);
  const readded = seed.changedRelPaths.filter((relPath) => seedDeleted.has(relPath));
  if (readded.length > 0) {
    const sources = await base.edgeSourcesInto(new Set(readded));
    for (const relPath of readded) {
      if ([...sourcesOf(sources, relPath)].some(outsideTreeDelta)) {
        return `${relPath}, deleted in the seed's tree, is back while files outside the delta reference it`;
      }
    }
  }
  const seedChanged = new Set(seed.seedChangedRelPaths);
  const appeared = moved.filter((definition) => definition.appeared && seedChanged.has(definition.relPath));
  if (appeared.length === 0) return undefined;
  const callers = await base.methodEdgeSourcesInto(new Set(appeared.map((definition) => definition.key)));
  for (const definition of appeared) {
    if ([...(callers.get(definition.key) ?? [])].some(outsideTreeDelta)) {
      return `${definition.key} reappears on a file the seed changed while files outside the delta call it`;
    }
  }
  return undefined;
}

/** A declaration on a touched file that the diff added or reshaped. */
interface MovedDeclaration {
  /** `fileScopedSymbolKey` — the method-edge vertex. */
  key: string;
  relPath: string;
  shortName: string;
  /** Absent before the diff (as opposed to reshaped). */
  appeared: boolean;
}

/** Each touched file's declarations as `vertex → shape`; line numbers excluded — a body edit moves them. */
async function declarationsOn(
  graphDb: GraphDbClient,
  relPaths: ReadonlySet<string>,
): Promise<Map<string, Declaration>> {
  const out = new Map<string, Declaration>();
  for (const definition of await graphDb.listAllSymbols()) {
    if (!relPaths.has(definition.relPath)) continue;
    const { startLine: _startLine, endLine: _endLine, ...shape } = definition;
    out.set(fileScopedSymbolKey(definition), {
      relPath: definition.relPath,
      shortName: definition.shortName,
      shape: JSON.stringify(shape, Object.keys(shape).sort()),
    });
  }
  return out;
}

interface Declaration {
  relPath: string;
  shortName: SymbolDefinition["shortName"];
  shape: string;
}

function movedDeclarations(
  before: ReadonlyMap<string, Declaration>,
  after: ReadonlyMap<string, Declaration>,
): MovedDeclaration[] {
  const moved: MovedDeclaration[] = [];
  for (const [key, declaration] of after) {
    const previous = before.get(key);
    if (previous?.shape === declaration.shape) continue;
    moved.push({ key, relPath: declaration.relPath, shortName: declaration.shortName, appeared: !previous });
  }
  return moved;
}

/** `target relPath → source relPaths`, per edge kind. */
interface EdgeSources {
  importers: Map<string, Set<string>>;
  callers: Map<string, Set<string>>;
}

/** Who imports, and who holds a resolved call into, each of `targets` — a file's own edges excluded. */
async function edgeSourcesInto(
  graphDb: Pick<GraphDbClient, "streamAdjacency">,
  targets: ReadonlySet<string>,
): Promise<EdgeSources> {
  const out: EdgeSources = { importers: new Map(), callers: new Map() };
  const add = (into: Map<string, Set<string>>, target: string, source: string): void => {
    if (!targets.has(target) || source === target) return;
    const sources = into.get(target) ?? new Set<string>();
    sources.add(source);
    into.set(target, sources);
  };
  for await (const [source, target] of graphDb.streamAdjacency("file")) add(out.importers, target, source);
  for await (const [source, target] of graphDb.streamAdjacency("method")) {
    add(out.callers, parseFileScopedSymbolKey(target).relPath, parseFileScopedSymbolKey(source).relPath);
  }
  return out;
}

/** Every source of either kind — into `target`, or into any target when omitted. */
function sourcesOf(edges: EdgeSources, target?: string): Set<string> {
  const out = new Set<string>();
  for (const byTarget of [edges.importers, edges.callers]) {
    for (const [into, sources] of byTarget) {
      if (target === undefined || into === target) for (const source of sources) out.add(source);
    }
  }
  return out;
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/** The files among `relPaths` whose text holds any of `names` as a whole identifier. */
async function filesNaming(
  treeRoot: string,
  relPaths: readonly string[],
  names: ReadonlySet<string>,
): Promise<string[]> {
  if (names.size === 0 || relPaths.length === 0) return [];
  const hits: string[] = [];
  for (const relPath of relPaths) {
    const text = await readFile(join(treeRoot, relPath), "utf-8").catch(() => undefined);
    if (text !== undefined && [...names].some((name) => mentions(text, name))) hits.push(relPath);
  }
  return hits.sort();
}

function mentions(text: string, name: string): boolean {
  if (name.length === 0) return false;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + name.length] ?? "";
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true;
  }
  return false;
}

/** The base snapshot, opened READ_ONLY on first use and only then. */
class BaseGraphProbe {
  private client: DuckDbGraphClient | undefined;

  constructor(private readonly snapshotPath: string) {}

  async holdsFile(relPath: string): Promise<boolean> {
    const rows = await (await this.open()).listFileContentHashes();
    return rows.some((row) => row.relPath === relPath);
  }

  async edgeSourcesInto(targets: ReadonlySet<string>): Promise<EdgeSources> {
    return edgeSourcesInto(await this.open(), targets);
  }

  /** `fileScopedSymbolKey → source relPaths` of the base's resolved calls into `keys`. */
  async methodEdgeSourcesInto(keys: ReadonlySet<string>): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for await (const [source, target] of (await this.open()).streamAdjacency("method")) {
      if (!keys.has(target)) continue;
      const sources = out.get(target) ?? new Set<string>();
      sources.add(parseFileScopedSymbolKey(source).relPath);
      out.set(target, sources);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private async open(): Promise<DuckDbGraphClient> {
    if (!this.client) {
      const client = new DuckDbGraphClient({ path: this.snapshotPath, accessMode: "READ_ONLY" });
      await client.init();
      this.client = client;
    }
    return this.client;
  }
}
