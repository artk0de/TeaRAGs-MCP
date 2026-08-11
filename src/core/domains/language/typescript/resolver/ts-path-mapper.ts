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
 * The winning `paths` entry for one specifier, and what its `*` captured.
 *
 * `prefixLength` is the ranking key, not a convenience: `tsc` resolves a
 * specifier against the pattern with the LONGEST matching prefix, so
 * `api/mocks/*` must beat both `api/*` and `*` on `api/mocks/getClient`
 * regardless of the order `paths` happens to declare them in.
 */
interface AliasPatternMatch {
  targets: readonly string[];
  /** Text the pattern's `*` stood for; empty for an exact (starless) pattern. */
  captured: string;
  prefixLength: number;
  /**
   * The pattern is the bare `"*"` — the one that matches EVERY bare specifier,
   * npm packages included, and therefore the one whose answers must be backed
   * by a file on disk.
   */
  catchAll: boolean;
}

/**
 * The `paths` entry `tsc` would resolve `importText` against, or `null`.
 *
 * Patterns are `prefix*suffix` — the general form, of which `"<prefix>/*"` and
 * the bare `"*"` are both cases. Matching only `pattern.endsWith("/*")` is what
 * left taxdome's `"*": ["./app/javascript/*"]` inert (bd tea-rags-mcp-t6ycg).
 *
 * An exact pattern wins outright and short-circuits: at most one literal can
 * equal the specifier, so there is nothing left to rank.
 */
function selectAliasPattern(importText: string, paths: Record<string, string[]>): AliasPatternMatch | null {
  let best: AliasPatternMatch | null = null;

  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern === importText) {
        return { targets, captured: "", prefixLength: pattern.length, catchAll: false };
      }
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!importText.startsWith(prefix) || !importText.endsWith(suffix)) continue;
    if (importText.length < prefix.length + suffix.length) continue;

    if (best !== null && prefix.length <= best.prefixLength) continue;
    best = {
      targets,
      captured: importText.slice(prefix.length, importText.length - suffix.length),
      prefixLength: prefix.length,
      catchAll: pattern === "*",
    };
  }

  return best;
}

/**
 * Walk the matched entry's substitutions in declaration order and take the
 * first one a file actually backs; `tsc` does the same, and only `targets[0]`
 * was ever consulted here, which made a second root dead config.
 *
 * When none of them can be verified the answer depends on how discriminating
 * the pattern was, and that split is the whole precision argument:
 *
 *   - a bare `"*"` matches every specifier there is, so an unverified answer
 *     fabricates an in-project path for `lodash/debounce`. Worse than a lost
 *     edge: `targetsExternalImport` reads a non-null mapping as "this call
 *     stays in the project", so one fabricated path switches the external
 *     classifier OFF for every npm package the project imports. Declining
 *     leaves the call external, which is where it belongs.
 *   - an author-declared pattern (`@/*`, `api/mocks/*`, a literal) cannot
 *     match an npm specifier in the first place, so it keeps the established
 *     behaviour of answering with its first candidate — a path no file table
 *     entry matches merely drops the edge (see {@link resolveTsSourcePath}).
 */
function resolveAliasMatch(
  match: AliasPatternMatch,
  options: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): string | null {
  const substituted = match.targets.map((target) =>
    posix.normalize(posix.join(options.baseUrl, target.replace("*", match.captured))),
  );
  if (substituted.length === 0) return null;

  for (const path of substituted) {
    const verified = verifiedTsSourcePath(path, fileExists);
    if (verified !== null) return verified;
  }
  return match.catchAll ? null : resolveTsSourcePath(substituted[0], fileExists);
}

/**
 * Repo-relative path of the file `importText` points at, or `null` when the
 * specifier does not name a project file (bare npm packages, `node:` builtins).
 *
 * `fileExists` lets the mapper pick the extension that is actually on disk
 * instead of committing to `.ts`; omit it and the mapper keeps its `.ts`-only
 * mapping rather than guessing (see {@link resolveTsSourcePath}). Under a bare
 * `"*"` catch-all the probe is not an optimisation but the only thing telling a
 * project module from an npm package, so without one that pattern declines.
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
  const match = selectAliasPattern(importText, options.paths);
  return match === null ? null : resolveAliasMatch(match, options, fileExists);
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
 * Basename of the module file a directory stands for. `"./components"` is a
 * legal specifier for `components/index.tsx`, and in a React or barrel-heavy
 * project it is the usual one (bd tea-rags-mcp-hzsxy).
 */
const DIRECTORY_MODULE_STEM = "index";

/**
 * Rewrite a mapped path's suffix to the TypeScript source file it stands for,
 * so graph edges land on paths that match the codegraph file table.
 *
 * `.ts` / `.tsx` / `.d.ts` are already explicit and pass through untouched.
 * Everything else has candidates, and `fileExists` picks among them — the
 * FIRST candidate that exists wins, so a project holding both `foo.ts` and
 * `foo.tsx` resolves the way `tsc` would.
 *
 * Candidate order IS `tsc`'s resolution order: the specifier as a file first,
 * then — for a specifier that named no extension — the directory it could be,
 * via its `index` module (bd tea-rags-mcp-hzsxy). A specifier that DID write a
 * suffix gets no directory candidates: `"./components.js"` names a file under
 * the NodeNext convention, and `"./components/index.js"` is how the directory
 * form is spelled, so probing `components.js/index.ts` would invent a module
 * nothing referenced.
 *
 * With no probe, or when no candidate exists, the first candidate is returned
 * unverified. That is deliberate: it is the pre-probe behaviour, and it is
 * recall-negative only — a path no file table entry matches drops the edge,
 * where a guessed `.tsx` would fabricate a `wrongFile` edge instead. This
 * codebase defers rather than fabricates (see `MethodEdgeKind`).
 */
function resolveTsSourcePath(path: string, fileExists?: ProjectFileProbe): string {
  // An explicit `.ts` / `.tsx` specifier has nothing to choose between, and
  // this returns BEFORE the probe on purpose: the probe's cache is what keeps
  // a resolve pass off one syscall per import per call site, and a lookup whose
  // answer cannot change the result is pure cost.
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return path;
  const candidates = tsSourcePathCandidates(path);
  return candidates.find((candidate) => fileExists?.(candidate)) ?? candidates[0];
}

/**
 * The candidate a probe CONFIRMED, or `null` when none exists — the same walk
 * as {@link resolveTsSourcePath} without its unverified fallback.
 *
 * Split out because one caller needs to tell "found it" from "guessed it", and
 * a return value that conflates them cannot express that: a bare `"*"` pattern
 * may only answer with a path a file backs (see {@link resolveAliasMatch}).
 * No probe means nothing can be confirmed, so the answer is `null` rather than
 * a guess.
 */
function verifiedTsSourcePath(path: string, fileExists?: ProjectFileProbe): string | null {
  if (fileExists === undefined) return null;
  return tsSourcePathCandidates(path).find((candidate) => fileExists(candidate)) ?? null;
}

/** Source files a mapped specifier could stand for, in `tsc`'s resolution order. */
function tsSourcePathCandidates(path: string): readonly string[] {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return [path];

  const rule = SOURCE_EXTENSION_CANDIDATES.find((entry) => path.endsWith(entry.suffix));
  const stem = rule ? path.slice(0, -rule.suffix.length) : path;
  const extensions = rule ? rule.extensions : EXTENSIONLESS_CANDIDATES;

  const asFile = extensions.map((extension) => `${stem}${extension}`);
  return rule ? asFile : [...asFile, ...extensions.map((extension) => `${stem}/${DIRECTORY_MODULE_STEM}${extension}`)];
}
