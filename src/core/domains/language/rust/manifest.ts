/**
 * Rust's crate manifest (bd tea-rags-mcp-sjego) — which file declares a crate
 * and how to read the crate's import name and root file out of one. Pure: the
 * directory walk that finds the files is the filesystem adapter's
 * (`adapters/filesystem/dependency-manifests.ts#readManifestFiles`), the same
 * split Go's `manifest.ts` keeps for `go.mod`.
 *
 * Deliberately NOT a `DependencyManifestSource`, for Go's reason: the fact the
 * resolver needs is not a dependency name but a crate name bound to the
 * directory its Cargo.toml sits in — ripgrep's `grep_matcher` lives in
 * `crates/matcher`.
 */

/** The one file name that declares a Cargo package. */
export const RUST_CRATE_MANIFEST_FILE = "Cargo.toml";

/**
 * Directories the Cargo.toml walk skips on top of the shared manifest walk's
 * own ignore list. `vendor/` is where `cargo vendor` copies every dependency's
 * Cargo.toml, and `target/` where `cargo package` unpacks one — both would
 * read a dependency as a workspace member.
 */
export const RUST_CRATE_WALK_IGNORED_DIRS: ReadonlySet<string> = new Set(["vendor", "target"]);

/** What a package manifest says about the crate other crates import. */
export interface RustCrateManifest {
  /** The name a `use` path spells: `[lib] name`, else `[package] name` with `-` normalised to `_`. */
  crateName: string;
  /** The crate root file, relative to the manifest's directory: `[lib] path`, else `src/lib.rs`. */
  rootFile: string;
}

const RUST_DEFAULT_CRATE_ROOT_FILE = "src/lib.rs";

/** A `[table]` header — `[[array]]` tables never match, so a `[[bin]] name` is never read as the package's. */
const TOML_TABLE_HEADER = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/;
const TOML_ARRAY_TABLE_HEADER = /^\[\[.*\]\]$/;
const TOML_STRING_KEY = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * The crate a Cargo.toml declares, or `undefined` for a manifest with no
 * `[package]` (a virtual workspace root). Reads only `name` and `path` from
 * the `[package]` and `[lib]` tables; the manifest is not source code, so a
 * line scan is the parser.
 */
export function parseRustCrateManifest(content: string): RustCrateManifest | undefined {
  const tables = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const header = TOML_ARRAY_TABLE_HEADER.test(line) ? undefined : TOML_TABLE_HEADER.exec(line)?.[1];
      current = header === "package" || header === "lib" ? new Map() : undefined;
      if (header !== undefined && current !== undefined) tables.set(header, current);
      continue;
    }
    const entry = current === undefined ? null : TOML_STRING_KEY.exec(line);
    if (entry) current?.set(entry[1], entry[2] ?? entry[3] ?? "");
  }
  const packageName = tables.get("package")?.get("name");
  if (packageName === undefined || packageName.length === 0) return undefined;
  const lib = tables.get("lib");
  return {
    crateName: (lib?.get("name") ?? packageName).replace(/-/g, "_"),
    rootFile: (lib?.get("path") ?? RUST_DEFAULT_CRATE_ROOT_FILE).replace(/^\.\//, ""),
  };
}
