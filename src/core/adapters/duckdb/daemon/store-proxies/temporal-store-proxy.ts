import type {
  CochangeFileLineCounts,
  CodegraphTemporalStore,
  RelPath,
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitFileSnapshot,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/** `CodegraphTemporalStore` over the daemon socket — co-change graph and symbol-commit store. */
export class DaemonTemporalStoreProxy implements CodegraphTemporalStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    await this.ops.call("replaceTemporalCochange", { snapshot });
  }

  async replaceTemporalSymbolCommits(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    await this.ops.call("replaceTemporalSymbolCommits", { files });
  }

  async deleteTemporalSymbolCommitFiles(relPaths: string[]): Promise<void> {
    await this.ops.call("deleteTemporalSymbolCommitFiles", { relPaths: [...relPaths] });
  }

  async storedTemporalSymbolCommitFilePaths(): Promise<string[]> {
    return (await this.ops.call("storedTemporalSymbolCommitFilePaths", {})) as string[];
  }

  async readTemporalSymbolCommits(relPath: string): Promise<TemporalSymbolCommitFileSnapshot> {
    return (await this.ops.call("readTemporalSymbolCommits", { relPath })) as TemporalSymbolCommitFileSnapshot;
  }

  async readTemporalCochangeMeta(): Promise<TemporalCochangeBuildMeta | null> {
    return (await this.ops.call("readTemporalCochangeMeta", {})) as TemporalCochangeBuildMeta | null;
  }

  async readTemporalCochangeGraph(): Promise<TemporalCochangeGraph> {
    // The server serialises the bundle Map as `[id, paths][]` entries — rebuild
    // it here (same pattern as getFileMetricsBulk). An older daemon's reply
    // carries no `bundles` at all: absence stays absence, never "no bundles".
    const { bundles, bundleCommits, bundleBursts, bundleTaskIds, bundleFileLines, bundleTimestamps, ...rest } =
      (await this.ops.call("readTemporalCochangeGraph", {})) as Omit<
        TemporalCochangeGraph,
        "bundles" | "bundleCommits" | "bundleBursts" | "bundleTaskIds" | "bundleFileLines" | "bundleTimestamps"
      > & {
        bundles?: [number, readonly RelPath[]][];
        bundleCommits?: [number, readonly string[]][];
        bundleBursts?: [number, number][];
        bundleTaskIds?: [number, readonly string[]][];
        bundleFileLines?: [number, [RelPath, CochangeFileLineCounts][]][];
        bundleTimestamps?: [number, number][];
      };
    return {
      ...rest,
      ...(bundles ? { bundles: new Map(bundles) } : {}),
      ...(bundleCommits ? { bundleCommits: new Map(bundleCommits) } : {}),
      ...(bundleBursts ? { bundleBursts: new Map(bundleBursts) } : {}),
      ...(bundleTaskIds ? { bundleTaskIds: new Map(bundleTaskIds) } : {}),
      ...(bundleFileLines
        ? { bundleFileLines: new Map(bundleFileLines.map(([bundleId, files]) => [bundleId, new Map(files)])) }
        : {}),
      ...(bundleTimestamps ? { bundleTimestamps: new Map(bundleTimestamps) } : {}),
    };
  }

  async readTemporalBundleFiles(): Promise<ReadonlyMap<number, readonly RelPath[]>> {
    return new Map((await this.ops.call("readTemporalBundleFiles", {})) as [number, readonly RelPath[]][]);
  }
}
