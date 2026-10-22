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
import {
  parseRustCrateManifest,
  parseRustDependencyRenames,
  parseRustPackageName,
  RUST_CRATE_MANIFEST_FILE,
  RUST_CRATE_WALK_IGNORED_DIRS,
  rustCrateNameOf,
} from "../manifest.js";

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

/** A member manifest: where it sits, the package it declares, the crate it roots. */
interface RustWorkspaceMember {
  relDir: string;
  packageName: string;
  crate: RustWorkspaceCrate;
}

/** `dir` joined with a manifest-relative `path` (`..` and `.` folded), or `undefined` when it leaves the repo. */
function resolveRelDir(dir: string, path: string): string | undefined {
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of path.replace(/\/+$/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.join("/");
}

/**
 * Candidate name → the members it would name. `undefined` in the set marks a
 * candidate pointing outside the workspace, which poisons the name like a
 * second member does.
 */
type RustCrateNameCandidates = Map<string, Set<RustWorkspaceCrate | undefined>>;

function addCandidate(candidates: RustCrateNameCandidates, name: string, crate: RustWorkspaceCrate | undefined): void {
  const targets = candidates.get(name) ?? new Set();
  targets.add(crate);
  candidates.set(name, targets);
}

/** A name joins only when it names exactly one member and no member already answers it. */
function addUnambiguousNames(
  crates: Map<string, RustWorkspaceCrate[]>,
  candidates: ReadonlyMap<string, ReadonlySet<RustWorkspaceCrate | undefined>>,
): void {
  for (const [name, targets] of candidates) {
    const [crate] = targets;
    if (targets.size !== 1 || crate === undefined || crates.has(name)) continue;
    crates.set(name, [crate]);
  }
}

/** The package-derived name of each member whose `[lib] name` replaced it. */
function packageDerivedNames(
  members: readonly RustWorkspaceMember[],
  crates: ReadonlyMap<string, readonly RustWorkspaceCrate[]>,
): RustCrateNameCandidates {
  const candidates: RustCrateNameCandidates = new Map();
  for (const member of members) {
    const derived = rustCrateNameOf(member.packageName);
    if (derived.length === 0 || crates.get(derived)?.includes(member.crate)) continue;
    addCandidate(candidates, derived, member.crate);
  }
  return candidates;
}

/** Every renamed dependency's key, bound to the member its `path` (else its `package`) names. */
function dependencyRenameNames(
  files: readonly { relDir: string; content: string }[],
  members: readonly RustWorkspaceMember[],
): RustCrateNameCandidates {
  const candidates: RustCrateNameCandidates = new Map();
  for (const file of files) {
    for (const rename of parseRustDependencyRenames(file.content)) {
      const dir = rename.path === undefined ? undefined : resolveRelDir(file.relDir, rename.path);
      const renamedMembers = members.filter(
        (member) => member.packageName === rename.packageName && (rename.path === undefined || member.relDir === dir),
      );
      addCandidate(candidates, rename.alias, renamedMembers.length === 1 ? renamedMembers[0]?.crate : undefined);
    }
  }
  return candidates;
}

export class RustWorkspaceCrateMap {
  private constructor(private readonly crates: ReadonlyMap<string, readonly RustWorkspaceCrate[]>) {}

  /**
   * Build from the manifests a walk found; a manifest with no `[package]`
   * declares no crate. Each member answers its crate name (`[lib] name`, else
   * the package's). Two kinds of name join on top, additively — never over a
   * name a member already answers: the package-derived name of a member whose
   * `[lib] name` differs, and the key of a renamed dependency
   * (`webxr-api = { package = "servo-webxr-api" }`) that names exactly one
   * member and that no other declaration maps elsewhere.
   */
  static fromManifests(files: readonly { relDir: string; content: string }[]): RustWorkspaceCrateMap {
    const crates = new Map<string, RustWorkspaceCrate[]>();
    const members: RustWorkspaceMember[] = [];
    for (const file of files) {
      const manifest = parseRustCrateManifest(file.content);
      if (manifest === undefined) continue;
      const rootFile = joinRel(file.relDir, manifest.rootFile);
      const crate: RustWorkspaceCrate = { rootFile, rootDir: parentDir(rootFile) };
      const entries = crates.get(manifest.crateName) ?? [];
      entries.push(crate);
      crates.set(manifest.crateName, entries);
      members.push({ relDir: file.relDir, packageName: parseRustPackageName(file.content) ?? "", crate });
    }
    addUnambiguousNames(crates, packageDerivedNames(members, crates));
    addUnambiguousNames(crates, dependencyRenameNames(files, members));
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
