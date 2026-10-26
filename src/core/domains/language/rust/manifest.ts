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
  const tables = readPackageAndLibTables(content);
  const packageName = tables.get("package")?.get("name");
  if (packageName === undefined || packageName.length === 0) return undefined;
  const lib = tables.get("lib");
  return {
    crateName: rustCrateNameOf(lib?.get("name") ?? packageName),
    rootFile: (lib?.get("path") ?? RUST_DEFAULT_CRATE_ROOT_FILE).replace(/^\.\//, ""),
  };
}

/** The `[package] name` a Cargo.toml declares, verbatim (`servo-webxr-api`), or `undefined` for a virtual root. */
export function parseRustPackageName(content: string): string | undefined {
  const packageName = readPackageAndLibTables(content).get("package")?.get("name");
  return packageName === undefined || packageName.length === 0 ? undefined : packageName;
}

/** The name a `use` path spells for a crate, package or dependency key: `-` normalised to `_`. */
export function rustCrateNameOf(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * A dependency declared under a name other than its package's:
 * `webxr-api = { package = "servo-webxr-api", path = "components/shared/webxr" }`.
 * Dependents import the crate under the KEY, so `use webxr_api::…` names the
 * `servo-webxr-api` package.
 */
export interface RustDependencyRename {
  /** The dependency key as a `use` path spells it (`webxr_api`). */
  alias: string;
  /** The `package` it renames, verbatim (`servo-webxr-api`). */
  packageName: string;
  /** The `path` key, relative to the declaring manifest's directory, when one is given. */
  path?: string;
}

/**
 * `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, their
 * `[target.'cfg(..)'.…]` and `[workspace.…]` forms, optionally narrowed to one
 * dependency (`[dependencies.webxr-api]`, captured in group 1).
 */
const RUST_DEPENDENCY_TABLE =
  /^(?:workspace\.|target\..+\.)?(?:dev[-_]|build[-_])?dependencies(?:\.([A-Za-z0-9_-]+|"[^"]+"))?$/;
const TOML_ANY_TABLE_HEADER = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;
const TOML_INLINE_TABLE_ENTRY = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}/;
const TOML_INLINE_STRING_KEY = (key: string): RegExp =>
  new RegExp(`(?:^|[{,\\s])${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);

/**
 * Every renamed dependency a Cargo.toml declares, in any dependency table —
 * inline (`alias = { package = "real", … }`) or as a sub-table
 * (`[dependencies.alias]` + `package = "real"`). An entry without `package`
 * is no rename: `alias = { workspace = true }` inherits the
 * `[workspace.dependencies]` declaration, which the root manifest carries.
 */
export function parseRustDependencyRenames(content: string): RustDependencyRename[] {
  const renames: RustDependencyRename[] = [];
  let inDependencies = false;
  let subTable: { key: string; values: Map<string, string> } | undefined;
  const flushSubTable = (): void => {
    if (subTable !== undefined) pushRename(renames, subTable.key, subTable.values);
    subTable = undefined;
  };
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flushSubTable();
      const header = TOML_ARRAY_TABLE_HEADER.test(line) ? undefined : TOML_ANY_TABLE_HEADER.exec(line)?.[1];
      const table = header === undefined ? null : RUST_DEPENDENCY_TABLE.exec(header);
      inDependencies = table !== null && table[1] === undefined;
      if (table?.[1] !== undefined) subTable = { key: table[1].replace(/"/g, ""), values: new Map() };
      continue;
    }
    if (subTable !== undefined) {
      const stringKey = TOML_STRING_KEY.exec(line);
      if (stringKey) subTable.values.set(stringKey[1], stringKey[2] ?? stringKey[3] ?? "");
      continue;
    }
    const inline = inDependencies ? TOML_INLINE_TABLE_ENTRY.exec(line) : null;
    if (inline) pushRename(renames, inline[1], inlineStringKeys(inline[2]));
  }
  flushSubTable();
  return renames;
}

function inlineStringKeys(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const key of ["package", "path"]) {
    const match = TOML_INLINE_STRING_KEY(key).exec(body);
    if (match) values.set(key, match[1] ?? match[2] ?? "");
  }
  return values;
}

function pushRename(renames: RustDependencyRename[], key: string, values: ReadonlyMap<string, string>): void {
  const packageName = values.get("package");
  if (packageName === undefined || packageName.length === 0) return;
  const path = values.get("path");
  renames.push({ alias: rustCrateNameOf(key), packageName, ...(path ? { path } : {}) });
}

/** The `[package]` and `[lib]` string keys; `[[array]]` tables and every other table are skipped. */
function readPackageAndLibTables(content: string): Map<string, Map<string, string>> {
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
  return tables;
}
