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
    const probed = probeImportPath(path, fileExists);
    if (probed.kind === "source") return probed.relPath;
    if (probed.kind === "asset") return null;
  }
  return match.catchAll ? null : resolveTsSourcePath(substituted[0], fileExists);
}

/**
 * A relative specifier as `tsc` defines one (`pathIsRelative`): `.` or `..`,
 * alone or followed by a separator. A specifier that merely starts with a dot
 * — `.storybook/blocks/…` — is bare and resolves through `paths`; joining it to
 * the caller's directory named a path that cannot exist (bd
 * tea-rags-mcp-unt4v).
 */
const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;

/**
 * Repo-relative path of the file `importText` points at, or `null` when the
 * specifier does not name a project file: bare npm packages, `node:` builtins,
 * and an ASSET import — a stylesheet, an image, a JSON module the probe finds
 * (bd tea-rags-mcp-unt4v). `null` is what every consumer reads as "outside the
 * project": no file edge, and a call on the import's binding is external.
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
  if (RELATIVE_SPECIFIER.test(importText)) {
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
 * in a React project, `foo.tsx`). `.mjs` / `.cjs` are the same convention for
 * the ESM- and CJS-only formats, whose sources are `.mts` / `.cts`.
 *
 * Each list ends with the specifier's own JavaScript file, where `tsc` under
 * `allowJs` ends too: a TypeScript file importing a module that really is
 * JavaScript (bd tea-rags-mcp-x9qsh). Last, so a TypeScript source or
 * declaration beside it always wins, and never first, so the unverified
 * fallback — the head of the list — stays the TypeScript source.
 */
const SOURCE_EXTENSION_CANDIDATES: readonly { suffix: string; extensions: readonly string[] }[] = [
  { suffix: ".js", extensions: [".ts", ".tsx", ".d.ts", ".js"] },
  { suffix: ".jsx", extensions: [".tsx", ".ts", ".jsx"] },
  { suffix: ".mjs", extensions: [".mts", ".d.mts", ".mjs"] },
  { suffix: ".cjs", extensions: [".cts", ".d.cts", ".cjs"] },
];

/**
 * Suffixes that name a TypeScript source as written, declarations included
 * (`.d.ts` / `.d.mts` / `.d.cts` end in one of these) — `allowImportingTsExtensions`,
 * `node --experimental-strip-types` and tsx all let source spell it, and
 * appending another source extension would name `worker.mts.ts`, a file that
 * cannot exist (bd tea-rags-mcp-x9qsh).
 */
const TS_SOURCE_AS_WRITTEN_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/**
 * A JSON module (`resolveJsonModule`) is spelled as written too — `tsc` never
 * reads `"./data.json"` as `data.json.ts` — but it is not a source, so it has
 * no source candidate at all: the probe finds it as an asset, or the
 * as-written path stands as the unverified answer (bd tea-rags-mcp-x9qsh).
 */
const JSON_MODULE_EXTENSION = ".json";

function namesTsSourceAsWritten(path: string): boolean {
  return TS_SOURCE_AS_WRITTEN_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Extensions tried for a specifier that writes no suffix at all (`"./foo"`),
 * for the file form and again for the directory's `index` module.
 *
 * `.js` / `.jsx` close each list, the order a bundler resolves a mixed TS/JS
 * project in: `import "./legacy"` for `legacy.js`, `import "./widgets"` for
 * `widgets/index.js` (bd tea-rags-mcp-x9qsh). Last, so every TypeScript source
 * and declaration of the same form wins; never first, so the unverified
 * fallback — the head of the list — stays the TypeScript source.
 */
const EXTENSIONLESS_CANDIDATES: readonly string[] = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];

/**
 * Basename of the module file a directory stands for. `"./components"` is a
 * legal specifier for `components/index.tsx`, and in a React or barrel-heavy
 * project it is the usual one (bd tea-rags-mcp-hzsxy).
 */
const DIRECTORY_MODULE_STEM = "index";

/**
 * Rewrite a mapped path's suffix to the TypeScript source file it stands for,
 * so graph edges land on paths that match the codegraph file table — or `null`
 * when the probe finds the path to be an ASSET (see {@link probeImportPath}).
 *
 * A suffix in {@link TS_SOURCE_AS_WRITTEN_EXTENSIONS} is already explicit and
 * passes through untouched.
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
 * With no probe, or when the probe confirms nothing, the first candidate is
 * returned unverified (a JSON module, which has none, keeps its as-written
 * path). That is deliberate: it is the pre-probe behaviour, and it is
 * recall-negative only — a path no file table entry matches drops the edge,
 * where a guessed `.tsx` would fabricate a `wrongFile` edge instead. This
 * codebase defers rather than fabricates (see `MethodEdgeKind`).
 */
function resolveTsSourcePath(path: string, fileExists?: ProjectFileProbe): string | null {
  // A specifier that names its source has nothing to choose between, and
  // this returns BEFORE the probe on purpose: the probe's cache is what keeps
  // a resolve pass off one syscall per import per call site, and a lookup whose
  // answer cannot change the result is pure cost.
  if (namesTsSourceAsWritten(path)) return path;
  const probed = probeImportPath(path, fileExists);
  if (probed.kind === "source") return probed.relPath;
  if (probed.kind === "asset") return null;
  return tsSourcePathCandidates(path)[0] ?? path;
}

/** What the probe made of one mapped path (see {@link probeImportPath}). */
type ProbedImportPath = { kind: "source"; relPath: string } | { kind: "asset" } | { kind: "unconfirmed" };

const ASSET_IMPORT: ProbedImportPath = { kind: "asset" };
const UNCONFIRMED_IMPORT: ProbedImportPath = { kind: "unconfirmed" };

/**
 * Walk a mapped path's source candidates against the probe and, LAST, the path
 * as written: a file there that no source candidate named is an ASSET — a CSS
 * module, an image, a JSON module (bd tea-rags-mcp-unt4v). The mapper used to
 * append a source extension to those and name `X.module.css.ts`, a file no row
 * can match; taxdome carried 1,922 such edges.
 *
 * The verdict comes from the probe alone, never from a list of asset
 * extensions: `user.service` is a dotted TypeScript basename, not an asset, and
 * the only thing that tells the two apart is that `user.service.ts` exists.
 * Order is what makes that safe — every source spelling of the path is a
 * candidate ahead of the as-written check, so reaching it means the file is
 * not a source. A directory is not a file, so it is never an asset.
 *
 * Split out because callers must tell "found it" from "guessed it": a bare
 * `"*"` pattern may only answer with a path a file backs (see
 * {@link resolveAliasMatch}). No probe confirms nothing.
 */
function probeImportPath(path: string, fileExists?: ProjectFileProbe): ProbedImportPath {
  if (fileExists === undefined) return UNCONFIRMED_IMPORT;
  const source = tsSourcePathCandidates(path).find((candidate) => fileExists(candidate));
  if (source !== undefined) return { kind: "source", relPath: source };
  return fileExists(path) ? ASSET_IMPORT : UNCONFIRMED_IMPORT;
}

/** Source files a mapped specifier could stand for, in `tsc`'s resolution order. */
function tsSourcePathCandidates(path: string): readonly string[] {
  if (namesTsSourceAsWritten(path)) return [path];
  if (path.endsWith(JSON_MODULE_EXTENSION)) return [];

  const rule = SOURCE_EXTENSION_CANDIDATES.find((entry) => path.endsWith(entry.suffix));
  const stem = rule ? path.slice(0, -rule.suffix.length) : path;
  const extensions = rule ? rule.extensions : EXTENSIONLESS_CANDIDATES;

  const asFile = extensions.map((extension) => `${stem}${extension}`);
  return rule ? asFile : [...asFile, ...extensions.map((extension) => `${stem}/${DIRECTORY_MODULE_STEM}${extension}`)];
}
