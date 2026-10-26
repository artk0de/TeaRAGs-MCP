/**
 * Where the toolchain's std/core/alloc sources live, and which toolchain they
 * belong to (bd s3i8m.7): `RUST_SRC_PATH` when set, else
 * `$(rustc --print sysroot)/lib/rustlib/src/rust/library` (the `rust-src`
 * component). The toolchain id keys the std cache: rustc's commit hash, or —
 * for a bare `RUST_SRC_PATH` — a digest of the library's own `Cargo.lock`, or
 * of its source listing when there is none.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const RUST_STD_CRATES = ["core", "alloc", "std"] as const;
const RUSTC_TIMEOUT_MS = 5000;

export interface RustLibraryLocation {
  /** The `library/` directory holding `{core,alloc,std}/src`. */
  readonly libraryDir: string;
  readonly toolchainId: string;
}

export interface RustLibraryLocatorDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Run `rustc` with `args`; stdout, or `undefined` when it is missing or fails. */
  readonly runRustc: (args: readonly string[]) => string | undefined;
}

export function locateRustLibrary(deps: RustLibraryLocatorDeps): RustLibraryLocation | undefined {
  const override = deps.env.RUST_SRC_PATH;
  if (override !== undefined && override !== "") {
    return hasRustLibrary(override) ? { libraryDir: override, toolchainId: rustLibraryDigest(override) } : undefined;
  }
  const sysroot = deps.runRustc(["--print", "sysroot"])?.trim();
  if (sysroot === undefined || sysroot === "") return undefined;
  const libraryDir = join(sysroot, "lib/rustlib/src/rust/library");
  if (!hasRustLibrary(libraryDir)) return undefined;
  const commit = /^commit-hash:\s*([0-9a-f]+)\s*$/m.exec(deps.runRustc(["-vV"]) ?? "")?.[1];
  return { libraryDir, toolchainId: commit ?? rustLibraryDigest(libraryDir) };
}

function hasRustLibrary(libraryDir: string): boolean {
  return existsSync(join(libraryDir, "std/src/lib.rs"));
}

/** `src-<16 hex>` over the library's `Cargo.lock`, else over its `.rs` listing (path + size). */
function rustLibraryDigest(libraryDir: string): string {
  const hash = createHash("sha256");
  const lock = join(libraryDir, "Cargo.lock");
  if (existsSync(lock)) {
    hash.update(readFileSync(lock));
  } else {
    for (const crate of RUST_STD_CRATES) {
      for (const file of listRustFiles(join(libraryDir, crate, "src"))) {
        hash.update(`${relative(libraryDir, file.path)}\0${file.size}\n`);
      }
    }
  }
  return `src-${hash.digest("hex").slice(0, 16)}`;
}

/** Every `.rs` file under `dir`, sorted by path, with its size. Unreadable entries are skipped. */
export function listRustFiles(dir: string): { path: string; size: number }[] {
  const files: { path: string; size: number }[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".rs")) {
        try {
          files.push({ path, size: statSync(path).size });
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  visit(dir);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The host's `rustc`, stdout on success; `undefined` when absent, failing or timed out. */
export function runHostRustc(args: readonly string[]): string | undefined {
  try {
    const result = spawnSync("rustc", args, { encoding: "utf8", timeout: RUSTC_TIMEOUT_MS });
    return result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}
