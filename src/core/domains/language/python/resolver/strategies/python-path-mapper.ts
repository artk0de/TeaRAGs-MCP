/**
 * Python import-path mapper. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/python/python-path-mapper.ts`
 * into the native Python language provider per the `domains/language`
 * consolidation (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Translates Python module-path strings (the `import X` / `from X
 * import Y` left side) into project-relative file paths. Two flavours:
 *
 *   - Absolute imports: `foo.bar` → `foo/bar.py` (or `foo/bar/__init__.py`
 *     for packages — we prefer the module file when both could exist).
 *   - Relative imports: leading dots count "go up" steps from the
 *     caller's directory. `.foo` from `pkg/a.py` → `pkg/foo.py`.
 *     `..foo.bar` from `pkg/sub/x.py` → `pkg/foo/bar.py`.
 *
 * Without a list of "known files on disk" we can't disambiguate
 * `foo.py` vs `foo/__init__.py` purely from the path; the resolver
 * takes the module-file shape and lets the symbol-table lookup do the
 * final disambiguation (if the target file isn't indexed, the edge
 * lands with `targetSymbolId: null`).
 */

import { posix } from "node:path";

export function mapPythonImportToFile(importText: string, callerFile: string): string | null {
  // Strip the alias suffix if any (rare; the walker normalises to
  // module-only, but be defensive).
  const head = importText.split(/\s+as\s+/)[0].trim();
  if (head.length === 0) return null;

  if (head.startsWith(".")) {
    return resolveRelative(head, callerFile);
  }
  return resolveAbsolute(head);
}

function resolveAbsolute(modulePath: string): string {
  // `foo.bar.baz` → `foo/bar/baz.py`. Strip empty segments defensively.
  const segments = modulePath.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  return `${segments.join("/")}.py`;
}

function resolveRelative(modulePath: string, callerFile: string): string | null {
  // Leading dots: `.foo` = same dir, `..foo` = parent dir, `...foo` =
  // grandparent, etc. The first dot means "current package"; each
  // subsequent dot means "go up one package".
  let dots = 0;
  while (dots < modulePath.length && modulePath[dots] === ".") dots++;
  const tail = modulePath.slice(dots);
  const callerDir = posix.dirname(callerFile);
  // `.` from `pkg/a.py` → callerDir = "pkg"; one dot means stay in
  // pkg. Two dots means parent of pkg.
  const upLevels = dots - 1;
  let baseDir = callerDir;
  for (let i = 0; i < upLevels; i++) {
    baseDir = posix.dirname(baseDir);
    if (baseDir === ".") baseDir = "";
  }
  if (tail.length === 0) {
    // `from . import x` — refers to the package itself; without
    // __init__.py heuristics we can't pin a file, return null so
    // the resolver falls back to global lookup.
    return null;
  }
  const tailPath = tail
    .split(".")
    .filter((s) => s.length > 0)
    .join("/");
  const joined = baseDir.length === 0 ? tailPath : posix.join(baseDir, tailPath);
  return `${joined}.py`;
}
