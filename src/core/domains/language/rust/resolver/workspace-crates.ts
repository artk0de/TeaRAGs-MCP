/**
 * The Cargo workspace crate map (bd tea-rags-mcp-sjego): which crate name a
 * `use` path head spells for which member directory. A member is imported by
 * its crate name, which need not match its directory — ripgrep's
 * `grep_matcher` is `crates/matcher` — so the symbol table's directory index
 * alone classified every such import external and lost its edges.
 *
 * Read once per pass through the injected manifest reader (Go's module-map
 * pattern, `GoModuleMapCache`), and handed to every Rust helper on the
 * caller's `CallContext.languageConfig` — the contract's language-specific
 * slot, as half of the `RustResolveEnvironment` — so neither the resolver nor
 * the kernel touches the disk.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ManifestFilesReader } from "../../../../contracts/types/language.js";
import { parseRustCrateManifest, RUST_CRATE_MANIFEST_FILE, RUST_CRATE_WALK_IGNORED_DIRS } from "../manifest.js";

interface RustWorkspaceCrate {
  /** Repo-relative crate root file (`crates/matcher/src/lib.rs`). */
  rootFile: string;
  /** Its directory — where `crate::` and `<crate_name>::` paths start (`crates/matcher/src`). */
  rootDir: string;
}

function joinRel(dir: string, file: string): string {
  return dir === "" ? file : `${dir}/${file}`;
}

function parentDir(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export class RustWorkspaceCrateMap {
  private constructor(private readonly crates: ReadonlyMap<string, readonly RustWorkspaceCrate[]>) {}

  /** Build from the manifests a walk found; a manifest with no `[package]` declares no crate. */
  static fromManifests(files: readonly { relDir: string; content: string }[]): RustWorkspaceCrateMap {
    const crates = new Map<string, RustWorkspaceCrate[]>();
    for (const file of files) {
      const manifest = parseRustCrateManifest(file.content);
      if (manifest === undefined) continue;
      const rootFile = joinRel(file.relDir, manifest.rootFile);
      const entries = crates.get(manifest.crateName) ?? [];
      entries.push({ rootFile, rootDir: parentDir(rootFile) });
      crates.set(manifest.crateName, entries);
    }
    return new RustWorkspaceCrateMap(crates);
  }

  /** Whether a workspace member is imported under `crateName`. */
  declares(crateName: string): boolean {
    return this.crates.has(crateName);
  }

  /** The crate root files of the members named `crateName` — several only when two members share a name. */
  rootFilesOf(crateName: string): readonly string[] {
    return (this.crates.get(crateName) ?? []).map((crate) => crate.rootFile);
  }

  /** The directories those crate roots sit in, where the crate's module paths start. */
  rootDirsOf(crateName: string): readonly string[] {
    return (this.crates.get(crateName) ?? []).map((crate) => crate.rootDir);
  }
}

/**
 * The crate map of the project a pass resolves. Single-entry, like
 * `GoModuleMapCache`: `reload` is what `prepareResolvePass` calls, so every
 * pass reads the Cargo.toml files as they are NOW. Without a root or an
 * injected reader there is nothing to read.
 */
export class RustWorkspaceCrateMapCache {
  private bound: { root: string; map: RustWorkspaceCrateMap } | undefined;

  constructor(private readonly manifestFilesReader?: ManifestFilesReader) {}

  forRoot(root: string | undefined): RustWorkspaceCrateMap | undefined {
    if (root === undefined || this.manifestFilesReader === undefined) return undefined;
    if (this.bound?.root !== root) this.reload(root);
    return this.bound?.map;
  }

  reload(root: string | undefined): void {
    if (root === undefined || this.manifestFilesReader === undefined) return;
    const files = this.manifestFilesReader(
      root,
      (fileName) => fileName === RUST_CRATE_MANIFEST_FILE,
      RUST_CRATE_WALK_IGNORED_DIRS,
    );
    this.bound = { root, map: RustWorkspaceCrateMap.fromManifests(files) };
  }
}

/**
 * The crate map the Rust resolver injected as the `crates` half of its
 * `RustResolveEnvironment` — `undefined` off its entry paths. Read by shape
 * plus an `instanceof` on the map itself, so this module does not import the
 * environment that imports it.
 */
export function rustWorkspaceCratesOf(ctx: CallContext): RustWorkspaceCrateMap | undefined {
  const config = ctx.languageConfig;
  const crates = typeof config === "object" && config !== null && "crates" in config ? config.crates : undefined;
  return crates instanceof RustWorkspaceCrateMap ? crates : undefined;
}
