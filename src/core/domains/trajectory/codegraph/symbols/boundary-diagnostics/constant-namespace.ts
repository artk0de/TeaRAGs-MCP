import type { FileDependencyGraphFile, RelPath } from "../../../../../contracts/types/codegraph.js";
import {
  classifyDirectoryRelation,
  CONSTANT_PATH_SEPARATOR,
  constantSegments,
  isNamespaceComponent,
  NAMESPACE_COMPONENT_PREFIX,
} from "../../component-geometry/index.js";
import type { DependencyDirectoryRelation } from "./types.js";

/**
 * The constant NAMESPACE each file belongs to, as a component name
 * (`::Billing`) — the component boundary where a language autoloads constants
 * by path (bd tea-rags-mcp-r8hme.11): Zeitwerk maps `app/models/billing/*` and
 * `app/services/billing/*` to one `Billing`, and a directory partition split
 * it in two.
 *
 * Derived from the declared scopes alone ({@link FileDependencyGraphFile.outerScopeNames}),
 * never from a directory list:
 *
 * 1. The file's PATH spells a declared constant — its trailing segments equal
 *    the constant's, compared case- and separator-insensitively
 *    (`billing/charge_service.rb` ↔ `Billing::ChargeService`). The namespace
 *    is the constant's parent, or the constant itself when it is top-level
 *    (`user.rb` ↔ `User` roots `User::*`). Longest match wins.
 * 2. Else the file's DIRECTORY spells one — the file declares inside it (a
 *    memberless class records only its enclosing namespace). The namespace is
 *    that constant.
 * 3. The namespace must be EVIDENCED as one: nested (it holds the separator)
 *    or the prefix of some declared name. A lone top-level `Account` is no
 *    namespace and keeps its directory; neither does a class whose language
 *    never qualifies names by constant path.
 *
 * A file whose path spells none of its constants — a monkey patch in an
 * initializer, a script — is absent and keeps the directory partition.
 */
export function deriveConstantNamespaceComponents(
  files: readonly FileDependencyGraphFile[],
): ReadonlyMap<RelPath, string> {
  const namespacePrefixes = new Set<string>();
  for (const f of files) {
    for (const name of f.outerScopeNames ?? []) {
      const segments = constantSegments(name);
      for (let k = 1; k < segments.length; k++) {
        namespacePrefixes.add(segments.slice(0, k).join(CONSTANT_PATH_SEPARATOR));
      }
    }
  }

  const namespaceOf = new Map<RelPath, string>();
  for (const f of files) {
    if (!f.outerScopeNames || f.outerScopeNames.length === 0) continue;
    const namespace = spelledNamespace(f.relPath, f.outerScopeNames);
    if (namespace === undefined) continue;
    if (!namespace.includes(CONSTANT_PATH_SEPARATOR) && !namespacePrefixes.has(namespace)) continue;
    namespaceOf.set(f.relPath, `${NAMESPACE_COMPONENT_PREFIX}${namespace}`);
  }
  return namespaceOf;
}

/**
 * How two components nest. Two namespaces nest by constant path
 * (`::Billing` holds `::Billing::Refunds`), two directories by path; a
 * namespace and a directory are always `disjoint` — the repository root is no
 * ancestor of a constant.
 */
export function classifyComponentRelation(source: string, target: string): DependencyDirectoryRelation {
  const sourceIsNamespace = isNamespaceComponent(source);
  if (sourceIsNamespace !== isNamespaceComponent(target)) return "disjoint";
  if (!sourceIsNamespace) return classifyDirectoryRelation(`${source}/_`, `${target}/_`);
  return classifyDirectoryRelation(`${namespacePath(source)}/_`, `${namespacePath(target)}/_`);
}

/** `::Billing::Refunds` → `Billing/Refunds`, so nesting reads like a path. */
function namespacePath(component: string): string {
  return constantSegments(component).join("/");
}

function spelledNamespace(relPath: RelPath, outerScopeNames: readonly string[]): string | undefined {
  const pathSegments = withoutExtension(relPath).split("/").map(normalizeSegment);
  const directorySegments = pathSegments.slice(0, -1);

  let fileMatch: string[] | undefined;
  let directoryMatch: string[] | undefined;
  for (const name of outerScopeNames) {
    const segments = constantSegments(name);
    const spelledByFile = longestSpelledPrefix(segments, pathSegments);
    if (spelledByFile && (!fileMatch || spelledByFile.length > fileMatch.length)) fileMatch = spelledByFile;
    const spelledByDirectory = longestSpelledPrefix(segments, directorySegments);
    if (spelledByDirectory && (!directoryMatch || spelledByDirectory.length > directoryMatch.length)) {
      directoryMatch = spelledByDirectory;
    }
  }

  if (fileMatch) return (fileMatch.length > 1 ? fileMatch.slice(0, -1) : fileMatch).join(CONSTANT_PATH_SEPARATOR);
  return directoryMatch?.join(CONSTANT_PATH_SEPARATOR);
}

/** The longest leading run of `constant` whose segments the tail of `path` spells. */
function longestSpelledPrefix(constant: readonly string[], path: readonly string[]): string[] | undefined {
  for (let k = Math.min(constant.length, path.length); k >= 1; k--) {
    const tail = path.slice(path.length - k);
    if (tail.every((segment, i) => segment === normalizeSegment(constant[i]))) return constant.slice(0, k);
  }
  return undefined;
}

/** Case- and word-separator-insensitive: `charge_service` = `ChargeService`, `api` = `API`. */
function normalizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/[_-]/g, "");
}

function withoutExtension(relPath: RelPath): string {
  const slash = relPath.lastIndexOf("/");
  const dot = relPath.lastIndexOf(".");
  return dot > slash + 1 ? relPath.slice(0, dot) : relPath;
}
