/**
 * The concrete `RustExternalSignatureSources` (bd s3i8m.7 T2): finds the
 * toolchain library and the dependency crates a project's code imports, reads
 * their sources, and keeps extracted tables in a disk cache shared across
 * projects at `${TEA_RAGS_DATA_DIR:-~/.tea-rags}/rust-signatures/`.
 *
 * Dependencies come from `Cargo.lock`: the external packages the workspace's
 * own packages depend on, kept only when a project `use` head names them.
 * Registry crates resolve to `$CARGO_HOME/registry/src/<index>/<name>-<version>`,
 * git crates to the package directory inside
 * `$CARGO_HOME/git/checkouts/<repository>-<hash>/<rev7>`. Total: anything not
 * found is an absence.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import type {
  RustExternalSignatureSources,
  RustExternalSignatureTableData,
  RustExternalSourceFile,
  RustExternalSourceSet,
  RustExternalSourcesOfProject,
} from "../../contracts/types/language.js";
import { isDebug } from "../../primitives/diagnostics/index.js";
import {
  cargoLockDirectDependencies,
  compareCargoVersions,
  parseCargoLock,
  type CargoLockPackage,
} from "./cargo-lock.js";
import {
  listRustFiles,
  locateRustLibrary,
  runHostRustc,
  RUST_STD_CRATES,
  type RustLibraryLocation,
} from "./rust-library.js";
import { readProjectRustUseHeads } from "./use-heads.js";

/** Default per-crate cap on `.rs` bytes: generated binding crates (`windows-sys`, `web-sys`) sit far above it. */
export const RUST_SIGNATURE_CRATE_SIZE_CAP_BYTES = 8 * 1024 * 1024;

export interface RustExternalSignatureSourcesOptions {
  /** Cache root; defaults to `${TEA_RAGS_DATA_DIR:-~/.tea-rags}/rust-signatures`. */
  readonly cacheDir?: string;
  /** Environment read for `CARGO_HOME`, `RUST_SRC_PATH`, `TEA_RAGS_DATA_DIR`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runRustc?: (args: readonly string[]) => string | undefined;
  readonly sizeCapBytes?: number;
}

export function createRustExternalSignatureSources(
  options: RustExternalSignatureSourcesOptions = {},
): RustExternalSignatureSources {
  const env = options.env ?? process.env;
  const cacheDir = options.cacheDir ?? join(env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "rust-signatures");
  const cargoHome = env.CARGO_HOME ?? join(homedir(), ".cargo");
  const sizeCapBytes = options.sizeCapBytes ?? RUST_SIGNATURE_CRATE_SIZE_CAP_BYTES;
  const runRustc = options.runRustc ?? runHostRustc;
  let library: { found: RustLibraryLocation | undefined } | undefined;
  // The toolchain is located once per process: a `rustc` spawn per run is the cost the cache exists to avoid.
  const libraryOnce = (): RustLibraryLocation | undefined => {
    if (library === undefined) {
      library = { found: locateRustLibrary({ env, runRustc }) };
      if (library.found === undefined && isDebug()) {
        console.error(
          "[rust-signatures] Rust std signatures unavailable (rust-src not found: rustup component add rust-src)",
        );
      }
    }
    return library.found;
  };
  return {
    sizeCapBytes,
    locate: (projectRoot) => locateProjectSources(projectRoot, libraryOnce(), cargoHome, sizeCapBytes),
    readCached: (key) => readCachedTable(join(cacheDir, `${key}.json`)),
    writeCached: (key, data) => {
      writeCachedTable(join(cacheDir, `${key}.json`), data);
    },
  };
}

let processSources: RustExternalSignatureSources | undefined;

/**
 * The process's sources over `process.env` — one instance, so the toolchain is
 * located once per process whichever composition (main thread, enrichment
 * worker, working-tree graph child) wires it.
 */
export function processRustExternalSignatureSources(): RustExternalSignatureSources {
  processSources ??= createRustExternalSignatureSources();
  return processSources;
}

function locateProjectSources(
  projectRoot: string,
  library: RustLibraryLocation | undefined,
  cargoHome: string,
  sizeCapBytes: number,
): RustExternalSourcesOfProject {
  const std = library === undefined ? undefined : stdSourceSet(library);
  const lockText = readTextOrUndefined(join(projectRoot, "Cargo.lock"));
  if (lockText === undefined) return { std, dependencies: [], lockDigest: undefined, missingCrates: [] };
  const lockDigest = createHash("sha256").update(lockText).digest("hex");
  const named = namedDependencies(
    cargoLockDirectDependencies(parseCargoLock(lockText)),
    readProjectRustUseHeads(projectRoot),
  );
  const dependencies: RustExternalSourceSet[] = [];
  const missingCrates: string[] = [];
  for (const pkg of named) {
    const set = dependencySourceSet(pkg, cargoHome, sizeCapBytes);
    if (set === undefined) missingCrates.push(`${pkg.name} ${pkg.version}`);
    else dependencies.push(set);
  }
  if (missingCrates.length > 0 && isDebug()) {
    console.error(
      `[rust-signatures] Rust dependency signatures: ${missingCrates.length} crates missing from ${cargoHome} (run cargo fetch)`,
    );
  }
  dependencies.sort((a, b) => (a.cacheKey < b.cacheKey ? -1 : a.cacheKey > b.cacheKey ? 1 : 0));
  return { std, dependencies, lockDigest, missingCrates };
}

/**
 * The direct dependencies a use head names (`serde-json` is imported as
 * `serde_json`). Two locked versions of one crate keep the highest: the table
 * keys types by crate path, so only one version can answer.
 */
function namedDependencies(direct: readonly CargoLockPackage[], heads: ReadonlySet<string>): CargoLockPackage[] {
  const chosen = new Map<string, CargoLockPackage>();
  for (const pkg of direct) {
    const crate = rustCrateNameOf(pkg.name);
    if (!heads.has(crate)) continue;
    const current = chosen.get(crate);
    if (current === undefined || compareCargoVersions(pkg.version, current.version) > 0) chosen.set(crate, pkg);
  }
  return [...chosen.values()];
}

function rustCrateNameOf(packageName: string): string {
  return packageName.replace(/-/g, "_");
}

function stdSourceSet(library: RustLibraryLocation): RustExternalSourceSet {
  return {
    cacheKey: `std/${library.toolchainId}`,
    readSources: () =>
      RUST_STD_CRATES.flatMap(
        (crate) => readCrateSources(crate, join(library.libraryDir, crate, "src"), Infinity) ?? [],
      ),
  };
}

function dependencySourceSet(
  pkg: CargoLockPackage,
  cargoHome: string,
  sizeCapBytes: number,
): RustExternalSourceSet | undefined {
  const crate = rustCrateNameOf(pkg.name);
  if (pkg.source.kind === "registry") {
    const dir = registryCrateDir(cargoHome, pkg);
    if (dir === undefined) return undefined;
    return {
      cacheKey: `crates/${pkg.name}-${pkg.version}`,
      readSources: () => readCrateSources(crate, join(dir, "src"), sizeCapBytes),
    };
  }
  if (pkg.source.kind === "git") {
    const rev7 = pkg.source.rev.slice(0, 7);
    const dir = gitCrateDir(cargoHome, pkg.source.repository, rev7, pkg.name);
    if (dir === undefined) return undefined;
    return {
      cacheKey: `crates/${pkg.name}-git-${rev7}`,
      readSources: () => readCrateSources(crate, join(dir, "src"), sizeCapBytes),
    };
  }
  return undefined;
}

function registryCrateDir(cargoHome: string, pkg: CargoLockPackage): string | undefined {
  const registry = join(cargoHome, "registry/src");
  for (const index of listDirNames(registry)) {
    const dir = join(registry, index, `${pkg.name}-${pkg.version}`);
    if (existsSync(join(dir, "src"))) return dir;
  }
  return undefined;
}

/** The package directory inside a git checkout: its root or a member up to two levels down whose manifest names it. */
function gitCrateDir(cargoHome: string, repository: string, rev7: string, packageName: string): string | undefined {
  const checkouts = join(cargoHome, "git/checkouts");
  for (const checkout of listDirNames(checkouts).filter((name) => name.startsWith(`${repository}-`))) {
    const root = join(checkouts, checkout, rev7);
    if (!existsSync(root)) continue;
    const levelOne = listDirNames(root).map((name) => join(root, name));
    const levelTwo = levelOne.flatMap((dir) => listDirNames(dir).map((name) => join(dir, name)));
    const found = [root, ...levelOne, ...levelTwo].find((dir) => manifestPackageName(dir) === packageName);
    if (found !== undefined) return found;
  }
  return undefined;
}

function manifestPackageName(dir: string): string | undefined {
  const manifest = readTextOrUndefined(join(dir, "Cargo.toml"));
  if (manifest === undefined) return undefined;
  const packageTable = /^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(manifest)?.[1] ?? "";
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(packageTable)?.[1];
}

/** The crate's `.rs` files relative to `src/`, or `undefined` over the cap. */
function readCrateSources(crate: string, srcDir: string, sizeCapBytes: number): RustExternalSourceFile[] | undefined {
  const files = listRustFiles(srcDir);
  if (files.reduce((sum, file) => sum + file.size, 0) > sizeCapBytes) return undefined;
  const sources: RustExternalSourceFile[] = [];
  for (const file of files) {
    const source = readTextOrUndefined(file.path);
    if (source !== undefined) {
      sources.push({ crate, relPath: relative(srcDir, file.path).split(sep).join("/"), source });
    }
  }
  return sources;
}

function readCachedTable(path: string): RustExternalSignatureTableData | undefined {
  const text = readTextOrUndefined(path);
  if (text === undefined) return undefined;
  try {
    const data = JSON.parse(text) as unknown;
    if (isTableData(data)) return data;
  } catch {
    // corrupt: dropped below, rebuilt by the next extraction
  }
  rmSync(path, { force: true });
  return undefined;
}

function isTableData(data: unknown): data is RustExternalSignatureTableData {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    Array.isArray(record.crates) &&
    [record.paths, record.types, record.aliases].every(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    )
  );
}

/** tmp + rename, so a concurrent reader sees the old file or the new one, never a torn write. */
function writeCachedTable(path: string, data: RustExternalSignatureTableData): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
