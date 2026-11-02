/**
 * Cargo roots of a project: the directories the rustc driver runs `cargo check`
 * in. A repository whose Rust code lives below the root (`backend/Cargo.toml`)
 * has no root manifest, so one run at the repository root would check nothing.
 */
import { join, posix } from "node:path";

import picomatch from "picomatch";

import type { RustCallSiteDefinition, RustCallSiteIndex } from "../../contracts/types/language.js";

const MANIFEST = "Cargo.toml";
/** Vendored sources and build output hold crates nobody checks on their own. */
const NOT_A_ROOT_DIRS: ReadonlySet<string> = new Set(["vendor", "target"]);

interface CargoWorkspace {
  /** Project-relative, `/`-separated; `""` is the project root. */
  relDir: string;
  /** Absent `members` = the root package and its path dependencies: everything below counts as covered. */
  members?: readonly string[];
  exclude: readonly string[];
}

/**
 * Directories holding a `Cargo.toml` that declares `[workspace]`, plus packages
 * no workspace's members cover; a project without any manifest answers
 * `[projectRoot]`. `files` are project-relative manifest paths; `readManifest`
 * takes an absolute path.
 */
export function findCargoRoots(
  projectRoot: string,
  files: readonly string[],
  readManifest: (path: string) => string,
): string[] {
  const workspaces: CargoWorkspace[] = [];
  const packages: string[] = [];
  for (const file of files) {
    if (posix.basename(file) !== MANIFEST) continue;
    const relDir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    if (relDir.split("/").some((segment) => NOT_A_ROOT_DIRS.has(segment))) continue;
    const workspace = workspaceSection(readManifest(join(projectRoot, file)));
    if (workspace === undefined) packages.push(relDir);
    else {
      workspaces.push({
        relDir,
        members: tomlArray(workspace, "members"),
        exclude: tomlArray(workspace, "exclude") ?? [],
      });
    }
  }
  const rootDirs = [
    ...workspaces.map((workspace) => workspace.relDir),
    ...packages.filter((relDir) => !isCovered(relDir, workspaces)),
  ];
  if (rootDirs.length === 0) return [projectRoot];
  return [...new Set(rootDirs)]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map((relDir) => (relDir === "" ? projectRoot : join(projectRoot, relDir)));
}

/**
 * One index over the per-root indexes: a project-relative path is answered by
 * the deepest root holding it, and an in-project definition's path is made
 * project-relative again.
 */
export function cargoRootsCallSiteIndex(
  rooted: readonly { relDir: string; index: RustCallSiteIndex }[],
): RustCallSiteIndex {
  const deepestFirst = [...rooted].sort((a, b) => b.relDir.length - a.relDir.length);
  return {
    identity: rooted.map(({ relDir, index }) => `${relDir}=${index.identity}`).join("|"),
    definitionAt: (relPath, line, utf16Col) => {
      for (const { relDir, index } of deepestFirst) {
        const prefix = relDir === "" ? "" : `${relDir}/`;
        if (!relPath.startsWith(prefix)) continue;
        return projectRelative(index.definitionAt(relPath.slice(prefix.length), line, utf16Col), prefix);
      }
      return null;
    },
  };
}

function projectRelative(definition: RustCallSiteDefinition | null, prefix: string): RustCallSiteDefinition | null {
  if (definition?.relPath === undefined || prefix === "") return definition;
  return { ...definition, relPath: `${prefix}${definition.relPath}` };
}

/** The nearest enclosing workspace decides: its members (or, without `members`, its whole subtree). */
function isCovered(relDir: string, workspaces: readonly CargoWorkspace[]): boolean {
  const enclosing = workspaces
    .filter(
      (workspace) =>
        workspace.relDir === "" || relDir === workspace.relDir || relDir.startsWith(`${workspace.relDir}/`),
    )
    .sort((a, b) => b.relDir.length - a.relDir.length)[0];
  if (!enclosing) return false;
  const inner = enclosing.relDir === "" ? relDir : relDir.slice(enclosing.relDir.length + 1);
  if (inner === "") return true;
  if (enclosing.exclude.some((pattern) => matchesDir(pattern, inner))) return false;
  return enclosing.members === undefined || enclosing.members.some((pattern) => matchesDir(pattern, inner));
}

function matchesDir(pattern: string, relDir: string): boolean {
  const normalized = posix.normalize(pattern).replace(/\/+$/, "");
  return picomatch(normalized, { dot: true })(relDir);
}

/** Body of the `[workspace]` table (up to the next table header); undefined when absent. */
function workspaceSection(manifest: string): string | undefined {
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[workspace\]\s*(#.*)?$/.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** String elements of `key = [ ... ]`, possibly multi-line; undefined when the key is absent. */
function tomlArray(section: string, key: string): string[] | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(section);
  if (!match) return undefined;
  const body = (match[1] ?? "").replace(/#[^\n]*/g, "");
  return [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map((element) => element[1] ?? element[2] ?? "");
}
