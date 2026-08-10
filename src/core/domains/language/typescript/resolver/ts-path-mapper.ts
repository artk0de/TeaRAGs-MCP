/**
 * TypeScript import-path mapper used by `TSCallResolver`.
 *
 * Slice-1 depth: relative paths + tsconfig `compilerOptions.paths` /
 * `baseUrl`. Bare npm specifiers (no relative prefix and no alias match)
 * are returned as `null` — graph edges for node_modules dependencies
 * are out of scope until Slice 3.
 */

import { existsSync, statSync } from "node:fs";
import { posix, resolve as resolvePath } from "node:path";

export interface TsCompilerOptions {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Answers whether a repo-relative path is a file in the indexed project.
 *
 * The mapper needs this because an import specifier does not name the
 * extension of the file it points at: `"./Button.js"` is `Button.ts` in one
 * project and `Button.tsx` in the next, and only the project tree can say
 * which. Injected rather than called directly so the mapper stays a pure
 * function of its inputs — tests supply a literal set, the resolver supplies
 * {@link createProjectFileProbe}.
 */
export type ProjectFileProbe = (relPath: string) => boolean;

/**
 * Filesystem-backed {@link ProjectFileProbe} rooted at `repoRoot`, memoized
 * per path.
 *
 * The cache is load-bearing, not an optimization detail: a resolve pass asks
 * about the same handful of imports once per call site across millions of
 * calls, and an un-cached `existsSync` would put a syscall on each. An index
 * run reads a fixed snapshot of the tree, so a path's answer cannot change
 * underneath the run that asked.
 */
export function createProjectFileProbe(repoRoot: string): ProjectFileProbe {
  const cache = new Map<string, boolean>();
  return (relPath: string): boolean => {
    const cached = cache.get(relPath);
    if (cached !== undefined) return cached;
    const absolute = resolvePath(repoRoot, relPath);
    let isFile: boolean;
    try {
      isFile = existsSync(absolute) && statSync(absolute).isFile();
    } catch {
      // A path that cannot be stat'd (permissions, a broken symlink) is not a
      // file we can resolve an edge to — treat it as absent rather than throw
      // mid-resolve.
      isFile = false;
    }
    cache.set(relPath, isFile);
    return isFile;
  };
}

/**
 * Repo-relative path of the file `importText` points at, or `null` when the
 * specifier does not name a project file (bare npm packages, `node:` builtins).
 *
 * `fileExists` lets the mapper pick the extension that is actually on disk
 * instead of committing to `.ts`; omit it and the mapper keeps its `.ts`-only
 * mapping rather than guessing (see {@link resolveTsSourcePath}).
 */
export function mapImportToFile(
  importText: string,
  callerFile: string,
  options: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): string | null {
  if (importText.startsWith(".")) {
    const dir = posix.dirname(callerFile);
    const joined = posix.normalize(posix.join(dir, importText));
    return resolveTsSourcePath(joined, fileExists);
  }
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "@/"
      if (importText.startsWith(prefix)) {
        const suffix = importText.slice(prefix.length);
        const target = targets[0]?.replace("/*", `/${suffix}`);
        if (!target) return null;
        return resolveTsSourcePath(posix.normalize(posix.join(options.baseUrl, target)), fileExists);
      }
    } else if (pattern === importText) {
      const target = targets[0];
      if (!target) return null;
      return resolveTsSourcePath(posix.normalize(posix.join(options.baseUrl, target)), fileExists);
    }
  }
  return null;
}

/**
 * The suffix a specifier writes, and the source extensions it can stand for,
 * in TypeScript's own precedence order. `.js` is the NodeNext convention —
 * source writes `import "./foo.js"` while the file on disk is `foo.ts` (or,
 * in a React project, `foo.tsx`).
 */
const SOURCE_EXTENSION_CANDIDATES: readonly { suffix: string; extensions: readonly string[] }[] = [
  { suffix: ".js", extensions: [".ts", ".tsx", ".d.ts"] },
  { suffix: ".jsx", extensions: [".tsx", ".ts"] },
];

/** Extensions tried for a specifier that writes no suffix at all (`"./foo"`). */
const EXTENSIONLESS_CANDIDATES: readonly string[] = [".ts", ".tsx", ".d.ts"];

/**
 * Rewrite a mapped path's suffix to the TypeScript source file it stands for,
 * so graph edges land on paths that match the codegraph file table.
 *
 * `.ts` / `.tsx` / `.d.ts` are already explicit and pass through untouched.
 * Everything else has candidates, and `fileExists` picks among them — the
 * FIRST candidate that exists wins, so a project holding both `foo.ts` and
 * `foo.tsx` resolves the way `tsc` would.
 *
 * With no probe, or when no candidate exists, the first candidate is returned
 * unverified. That is deliberate: it is the pre-probe behaviour, and it is
 * recall-negative only — a path no file table entry matches drops the edge,
 * where a guessed `.tsx` would fabricate a `wrongFile` edge instead. This
 * codebase defers rather than fabricates (see `MethodEdgeKind`).
 */
function resolveTsSourcePath(path: string, fileExists?: ProjectFileProbe): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return path;

  const rule = SOURCE_EXTENSION_CANDIDATES.find((entry) => path.endsWith(entry.suffix));
  const stem = rule ? path.slice(0, -rule.suffix.length) : path;
  const extensions = rule ? rule.extensions : EXTENSIONLESS_CANDIDATES;

  const candidates = extensions.map((extension) => `${stem}${extension}`);
  return candidates.find((candidate) => fileExists?.(candidate)) ?? candidates[0];
}
