/**
 * `Cargo.lock` reading for the Rust external signature table (bd s3i8m.7):
 * which exact package a project's dependency is, and where its source came
 * from. Line-based over the `[[package]]` tables every lockfile version shares
 * (v1/v2 `name version (source)` dependency entries, v3/v4 `name` or
 * `name version`). The lock records no features and no target.
 */

export type CargoLockSource =
  | { readonly kind: "registry" }
  | { readonly kind: "git"; readonly repository: string; readonly rev: string }
  | { readonly kind: "path" };

export interface CargoLockPackage {
  readonly name: string;
  readonly version: string;
  readonly source: CargoLockSource;
  /** Dependency entries as written: `name`, `name version` or `name version (source)`. */
  readonly dependencies: readonly string[];
}

interface PackageDraft {
  name?: string;
  version?: string;
  source?: string;
  dependencies: string[];
}

const KEY_VALUE = /^(\w+)\s*=\s*"([^"]*)"\s*$/;
const ARRAY_ITEM = /^\s*"([^"]*)",?\s*$/;

export function parseCargoLock(text: string): CargoLockPackage[] {
  const packages: CargoLockPackage[] = [];
  let draft: PackageDraft | undefined;
  let inDependencies = false;
  const flush = (): void => {
    if (draft?.name !== undefined && draft.version !== undefined) {
      packages.push({
        name: draft.name,
        version: draft.version,
        source: cargoLockSourceOf(draft.source),
        dependencies: draft.dependencies,
      });
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      if (inDependencies && line === "]") {
        inDependencies = false;
        continue;
      }
      flush();
      draft = line === "[[package]]" ? { dependencies: [] } : undefined;
      inDependencies = false;
      continue;
    }
    if (draft === undefined) continue;
    if (inDependencies) {
      const item = ARRAY_ITEM.exec(line);
      if (item?.[1] !== undefined) draft.dependencies.push(item[1]);
      else if (line === "]") inDependencies = false;
      continue;
    }
    if (line.startsWith("dependencies = [")) {
      inDependencies = !line.endsWith("]");
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (pair === null) continue;
    const [, key, value] = pair;
    if (key === "name") draft.name = value;
    else if (key === "version") draft.version = value;
    else if (key === "source") draft.source = value;
  }
  flush();
  return packages;
}

/**
 * `registry+…` / `sparse+…` → registry; `git+<url>#<rev>` → the checkout's
 * repository directory stem (last URL path segment, `.git` and query dropped)
 * and the locked revision; no source → a workspace or path package.
 */
function cargoLockSourceOf(source: string | undefined): CargoLockSource {
  if (source === undefined) return { kind: "path" };
  if (!source.startsWith("git+")) return { kind: "registry" };
  const hash = source.lastIndexOf("#");
  const url = (hash >= 0 ? source.slice(4, hash) : source.slice(4)).split("?")[0] ?? "";
  const repository = (url.replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.git$/, "");
  return { kind: "git", repository, rev: hash >= 0 ? source.slice(hash + 1) : "" };
}

/**
 * The external packages the project's own (path) packages depend on, each
 * resolved to its exact lock entry, sorted by name then version. A `use` head
 * can only name one of these, so the transitive closure is never read.
 */
export function cargoLockDirectDependencies(packages: readonly CargoLockPackage[]): CargoLockPackage[] {
  const byName = new Map<string, CargoLockPackage[]>();
  for (const pkg of packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
  const direct = new Set<CargoLockPackage>();
  for (const member of packages) {
    if (member.source.kind !== "path") continue;
    for (const entry of member.dependencies) {
      const [name = "", version] = entry.split(" ");
      const candidates = byName.get(name) ?? [];
      const found =
        version === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((c) => c.version === version);
      if (found !== undefined && found.source.kind !== "path") direct.add(found);
    }
  }
  return [...direct].sort((a, b) => a.name.localeCompare(b.name) || compareCargoVersions(a.version, b.version));
}

/** Numeric-aware semver order (`0.2.11` < `1.10.2`); pre-release suffixes compare as text. */
export function compareCargoVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
