/**
 * `PythonImportFileMapper` — which project file an import statement names
 * (bd tea-rags-mcp-9fgdi, E2 seam 1).
 *
 * `mapPythonImportToFile` synthesises a candidate path from the module text
 * alone: `dcim.models` becomes `dcim/models.py`. netbox's file is
 * `netbox/dcim/models/__init__.py` — wrong root, wrong shape. That guess is
 * committed as a file edge and persisted unfiltered, so 39% of netbox's and
 * 62% of ugnest's first-party absolute imports point at files that do not
 * exist, and every Python file signal is computed over them.
 *
 * This class answers the same question from symbol-table MEMBERSHIP: the root
 * is inferred from paths the table already holds, and `.py` vs `__init__.py` vs
 * namespace directory is decided by `hasFile` / `hasFilesUnder` rather than by
 * convention. NO DISK. Pass 2 runs against a hydrated table whose working tree
 * may have moved on, and a `statSync` per import per file is a syscall storm on
 * a 24k-file corpus besides.
 *
 * `hasFile` answers MEMBERSHIP, not symbol count (bd tea-rags-mcp-o7ifx), so a
 * genuinely empty `__init__.py` resolves to itself rather than collapsing into
 * the PEP 420 namespace-directory verdict. A namespace directory still answers
 * `unknown` — conservative in the same direction as decision 4 of
 * `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md`: no edge
 * beats a phantom edge.
 *
 * `resolveExportedName` answers the OTHER question a caller can have — which
 * file DECLARES a name, not which file a module names (bd tea-rags-mcp-xpl83.3).
 * They differ wherever a package re-exports: netbox's `core/models/__init__.py`
 * declares nothing and star-imports six siblings, and `from core.models import
 * ObjectType` maps to it correctly and uselessly. Same discipline — symbol-table
 * membership, no disk — one hop further along the file's own `from` statements,
 * bounded and unanimity-gated so an ambiguity stays a refusal.
 */

import { posix } from "node:path";

import type { CallContext, GlobalSymbolTable, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";
import { lookupPythonSymbolsByShortName } from "./strategies/shared.js";

/** The suffix that makes a directory a package; `pkg/__init__.py` -> `pkg/`. */
const INIT_PY = "/__init__.py";

const EXTERNAL: ImportFileTarget = { kind: "external" };
const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/** What one root said about one module path. `miss` alone lets the scan move on. */
type ImportPathProbe = { kind: "project"; relPath: RelPath } | { kind: "namespace" } | { kind: "miss" };

const NAMESPACE: ImportPathProbe = { kind: "namespace" };
const MISS: ImportPathProbe = { kind: "miss" };

/**
 * Per-symbol-table memo. Keyed by table IDENTITY (a run holds one) and
 * invalidated when `size()` moves, which is the same shape the TS path mapper
 * uses for its `existsSync` memo — pass 1 grows the table, pass 2 does not.
 *
 * `roots` is the ordered set of roots that fit: SEEDED from the table's file
 * set when it can list one (bd tea-rags-mcp-60nss), then extended lazily by
 * whatever the ancestor scan proves. On a corpus with one source root, the
 * second import onward skips most of the ancestor scan.
 * `seededCount` marks where the seeded prefix ends, because only a SEEDED root
 * may be hoisted for containing the caller (bd tea-rags-mcp-hg427) — a lazily
 * learned one is an ancestor of the caller already and the scan reaches it.
 * `containingRoots` is that hoist, memoised per `fromDir`: the seeded prefix is
 * fixed for the memo generation, so the answer is a function of `fromDir` alone
 * and costs one scan per directory rather than one per import.
 * `answers` is keyed by `<dir> <importText>` because the same text resolves
 * differently from two directories — every relative import, and any absolute
 * one whose root inference depends on the caller's ancestors.
 */
interface ImportMapperMemo {
  size: number;
  roots: string[];
  seededCount: number;
  containingRoots: Map<string, string>;
  answers: Map<string, ImportFileTarget>;
  /** `<file> <name>` -> the file that DECLARES it, or `null` for "cannot tell". */
  declarers: Map<string, RelPath | null>;
}

/**
 * How many re-export hops {@link PythonImportFileMapper.resolveExportedName}
 * will take.
 *
 * Packages re-export packages — netbox's `core/models/__init__.py` star-imports
 * six siblings, and a name can travel `pkg/__init__.py` -> `sub/__init__.py` ->
 * `sub/leaf.py` before it is declared. Three covers every shape the five corpora
 * hold; a deeper tower answers `null`, which is the pre-seam refusal rather than
 * a guess. The bound is what keeps a re-export CYCLE (legal, and present in the
 * wild via `from . import x` inside a submodule) from costing a whole run — the
 * visited set alone makes it terminate, the budget makes it cheap.
 */
const MAX_REEXPORT_HOPS = 3;

export class PythonImportFileMapper implements ImportFileMapper {
  private readonly memos = new WeakMap<GlobalSymbolTable, ImportMapperMemo>();

  mapImportToFile(importText: string, fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const head = importText.split(/\s+as\s+/)[0].trim();
    if (head.length === 0) return UNKNOWN;

    const table = ctx.symbolTable;
    const memo = this.memoFor(table);
    const fromDir = posix.dirname(fromFile);
    const key = `${fromDir} ${head}`;
    const cached = memo.answers.get(key);
    if (cached !== undefined) return cached;

    const answer = head.startsWith(".") ? mapRelative(head, fromDir, table) : mapAbsolute(head, fromDir, table, memo);
    memo.answers.set(key, answer);
    return answer;
  }

  /**
   * Which file DECLARES `name`, starting from the file an import mapped to (bd
   * tea-rags-mcp-xpl83.3).
   *
   * `mapImportToFile` answers which file a MODULE names, and that is a different
   * question: netbox's `from core.models import ObjectType` maps to
   * `core/models/__init__.py`, which declares nothing and star-imports six
   * siblings. The name is real, the file is right, and neither fact names the
   * class — which matters only because netbox declares a second `ObjectType` in
   * `netbox/graphql/types.py`, so the caller cannot pick one on no evidence.
   *
   * A file that declares the name is returned UNCHANGED, so nothing that
   * resolves today moves. Otherwise the file's own `from` statements are
   * consulted, EXPLICIT entries first: an `as` alias names the source spelling,
   * which a star cannot. Stars are the fallback and are held to unanimity — one
   * source declaring the name is evidence, two is the same ambiguity the caller
   * refused to guess at, and refusing is what this returns.
   *
   * `null` means "no better answer than the file you came in with", never "the
   * name is absent": the caller keeps whatever it had.
   */
  resolveExportedName(relPath: RelPath, name: string, ctx: CallContext): RelPath | null {
    if (name.length === 0 || name === "*") return null;
    const memo = this.memoFor(ctx.symbolTable);
    const key = `${relPath} ${name}`;
    const cached = memo.declarers.get(key);
    if (cached !== undefined) return cached;
    const answer = this.followReexports(relPath, name, ctx, 0, new Set([relPath]));
    memo.declarers.set(key, answer);
    return answer;
  }

  /** One hop of {@link PythonImportFileMapper.resolveExportedName}; see its contract. */
  private followReexports(
    relPath: RelPath,
    name: string,
    ctx: CallContext,
    depth: number,
    visited: Set<RelPath>,
  ): RelPath | null {
    if (declaresName(relPath, name, ctx)) return relPath;
    if (depth >= MAX_REEXPORT_HOPS) return null;
    const entries = ctx.moduleReexports?.[relPath];
    if (entries === undefined) return null;
    for (const entry of entries) {
      if (entry.exportedName !== name || entry.sourceName === undefined) continue;
      const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
      if (source === null) continue;
      const hit = this.followReexports(source, entry.sourceName, ctx, depth + 1, visited);
      if (hit !== null) return hit;
    }
    // Stars, unanimous or not at all.
    let only: RelPath | null = null;
    for (const entry of entries) {
      if (entry.exportedName !== "*") continue;
      const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
      if (source === null) continue;
      const hit = this.followReexports(source, name, ctx, depth + 1, visited);
      if (hit === null) continue;
      if (only !== null && only !== hit) return null;
      only = hit;
    }
    return only;
  }

  /**
   * The project file one re-export entry points at, or `null` when it leaves the
   * project or has already been walked.
   *
   * The module text is resolved relative to the RE-EXPORTING file, which is what
   * makes `.object_types` mean `core/models/object_types.py` and not something
   * under the caller. Marking the target visited BEFORE the recursion is what
   * terminates a cycle; a branch that returns nothing costs the later branches
   * nothing, because they would reach the same nothing.
   */
  private stepToSource(
    fromFile: RelPath,
    sourceModule: string,
    ctx: CallContext,
    visited: Set<RelPath>,
  ): RelPath | null {
    const target = this.mapImportToFile(sourceModule, fromFile, ctx);
    if (target.kind !== "project" || visited.has(target.relPath)) return null;
    visited.add(target.relPath);
    return target.relPath;
  }

  private memoFor(table: GlobalSymbolTable): ImportMapperMemo {
    const existing = this.memos.get(table);
    const size = table.size();
    // A grown table can turn `external` into `project`; a stale memo would
    // freeze the cold-pass answer for the whole run.
    if (existing?.size === size) return existing;
    const roots = seedRoots(table);
    const fresh: ImportMapperMemo = {
      size,
      roots,
      seededCount: roots.length,
      containingRoots: new Map(),
      answers: new Map(),
      declarers: new Map(),
    };
    this.memos.set(table, fresh);
    return fresh;
  }
}

/**
 * Does `relPath` itself declare something short-named `name`?
 *
 * The same membership question the rest of this class asks, aimed at a SYMBOL
 * rather than a file. A `__init__.py` that re-exports answers `false` here —
 * `collectSymbols` records definitions, not bindings — which is exactly the
 * trigger for the follow.
 */
function declaresName(relPath: RelPath, name: string, ctx: CallContext): boolean {
  return lookupPythonSymbolsByShortName(ctx, name).some((def) => def.relPath === relPath);
}

/**
 * The project's source roots, read off the table's file set (bd
 * tea-rags-mcp-60nss).
 *
 * A root is any directory R holding a PACKAGE — some `R/<pkg>/__init__.py` —
 * that is not itself a package, i.e. `R/__init__.py` is absent. `src` for
 * flask's `src/flask/__init__.py`; `netbox` for `netbox/dcim/__init__.py`;
 * `""` for httpx's top-level `httpx/__init__.py`. `netbox/dcim` is excluded
 * even though it holds `models/__init__.py`, because `netbox/dcim/__init__.py`
 * makes it a package rather than a root.
 *
 * Why this is not the ancestor scan's job: the scan can only ever prove a root
 * the importing file sits UNDER. flask's `examples/app.py` imports `flask`
 * absolutely and `src` is nobody's ancestor there, so the scan exhausted and 15
 * bare calls fell out `external` — and whether it exhausted depended on walk
 * order, since visiting `src/flask/app.py` first happened to prove `src`
 * lazily.
 *
 * Sorted DEEPEST first, then lexicographically: same tie-break as the ancestor
 * scan (a nested root must not be shadowed by the one above it), and it makes
 * the answer independent of the order files entered the table.
 *
 * One pass over the file keys per memo generation — O(files), no filesystem.
 * Pass 2 runs against a table that no longer grows, so it happens once.
 */
function seedRoots(table: GlobalSymbolTable): string[] {
  if (table.listFiles === undefined) return [];
  const roots = new Set<string>();
  for (const relPath of table.listFiles()) {
    if (!relPath.endsWith(INIT_PY)) continue;
    const pkgDir = relPath.slice(0, relPath.length - INIT_PY.length);
    // `__init__.py` at the repo root has no enclosing directory to be a root of.
    if (pkgDir.length === 0) continue;
    const slash = pkgDir.lastIndexOf("/");
    const root = slash === -1 ? "" : pkgDir.slice(0, slash);
    if (roots.has(root)) continue;
    if (table.hasFile(root.length === 0 ? "__init__.py" : `${root}/__init__.py`)) continue;
    roots.add(root);
  }
  return [...roots].sort(byDepthDesc);
}

/** Deepest first, then lexicographic — a total order, so seeding is stable. */
function byDepthDesc(a: string, b: string): number {
  const depth = segmentCount(b) - segmentCount(a);
  return depth !== 0 ? depth : a.localeCompare(b);
}

function segmentCount(dir: string): number {
  return dir.length === 0 ? 0 : dir.split("/").length;
}

/**
 * `.foo` / `..foo.bar` / `.` — already anchored to the importing file's
 * package, so root inference must NOT run. `.orders` from
 * `domains/billing/invoice.py` is `domains/billing/orders`, and a mapper that
 * fell back to root inference would answer `domains/orders` instead.
 *
 * A relative import can never name a library either, so a miss is `unknown`
 * and never `external`.
 */
function mapRelative(head: string, fromDir: string, table: GlobalSymbolTable): ImportFileTarget {
  let dots = 0;
  while (dots < head.length && head[dots] === ".") dots++;
  let baseDir = fromDir === "." ? "" : fromDir;
  for (let i = 0; i < dots - 1; i++) {
    if (baseDir.length === 0) return UNKNOWN; // walked above the repo root
    baseDir = posix.dirname(baseDir);
    if (baseDir === ".") baseDir = "";
  }
  const tail = head
    .slice(dots)
    .split(".")
    .filter((s) => s.length > 0);
  const dir = [baseDir, ...tail].filter((s) => s.length > 0).join("/");
  // `from . import x` arrives here as `"."` with an empty tail: the package
  // itself. Task 5's strategy is what tries `<dir>/x.py` first, because only
  // it can see `importedNames`.
  const probe = probePath(dir, table);
  return probe.kind === "project" ? { kind: "project", relPath: probe.relPath } : UNKNOWN;
}

/**
 * `a.b.c` — the import root is not the repo root in three of the five corpora,
 * and nothing in the module text says which it is. Try roots cheapest-first:
 * `""`, then the seeded root CONTAINING the caller, then the memo's remaining
 * proven ones, then the importing file's ancestors DEEPEST to SHALLOWEST.
 *
 * Deepest-first is load-bearing. netbox holds both `netbox/netbox/settings.py`
 * and the outer `netbox/` directory; a shallow-first ancestor scan would let
 * the outer one shadow the inner package for `netbox.settings`.
 *
 * But one global order cannot be right for a corpus owning two packages of the
 * same name, and polar owns three `polar` directories. `sdk/generator/python/
 * template` is four segments deep and `sdk/python` is two, so deepest-first
 * alone sent every caller under `sdk/python/**` into the generator's template
 * copy — 1,468 of polar's 1,618 `wrongFile` rows (bd tea-rags-mcp-hg427). The
 * caller's own root leads instead, which is the rule the deterministic oracle
 * already applies per file (`order_roots` in `scripts/py-oracle/jedi_oracle.py`,
 * E0.11); deepest-first survives as the tie-break for a caller under no root.
 */
function mapAbsolute(
  head: string,
  fromDir: string,
  table: GlobalSymbolTable,
  memo: ImportMapperMemo,
): ImportFileTarget {
  const segments = head.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return UNKNOWN;
  const modulePath = segments.join("/");

  for (const root of candidateRoots(fromDir, memo.roots, containingSeededRoot(fromDir, memo))) {
    const probe = probePath(root.length === 0 ? modulePath : `${root}/${modulePath}`, table);
    if (probe.kind === "miss") continue;
    if (!memo.roots.includes(root)) memo.roots.push(root);
    return probe.kind === "project" ? { kind: "project", relPath: probe.relPath } : UNKNOWN;
  }

  // Nothing in the project holds it. The stdlib snapshot is checked FIRST so
  // the verdict is positive rather than residual, but the outcome is the same
  // either way — with one exception: an EMPTY table proves nothing, and calling
  // every import external there would silently zero the file graph on a cold or
  // degraded pass.
  if (PYTHON_STDLIB_MODULES.has(segments[0])) return EXTERNAL;
  return table.size() > 0 ? EXTERNAL : UNKNOWN;
}

/**
 * The deepest SEEDED root that contains `fromDir`, or `""` for none.
 *
 * `""` doubles as the "none" answer because hoisting it would be a no-op: the
 * repo root is already `candidateRoots`' first candidate.
 *
 * The seeded prefix is sorted deepest-first, so the FIRST containing root in it
 * is the deepest — two roots at the same depth cannot both be ancestors of one
 * directory. Containment is tested on a separator boundary, so `server` does
 * not swallow `server-tools/x.py`, and a file sitting directly in the root
 * counts as contained.
 */
function containingSeededRoot(fromDir: string, memo: ImportMapperMemo): string {
  const cached = memo.containingRoots.get(fromDir);
  if (cached !== undefined) return cached;
  let containing = "";
  for (let i = 0; i < memo.seededCount; i++) {
    const root = memo.roots[i];
    if (root.length === 0) continue;
    if (fromDir === root || fromDir.startsWith(`${root}/`)) {
      containing = root;
      break;
    }
  }
  memo.containingRoots.set(fromDir, containing);
  return containing;
}

/**
 * `""`, the caller's own seeded root, the remaining memo-proven roots, then the
 * caller's ancestors deepest-first.
 */
function candidateRoots(fromDir: string, provenRoots: readonly string[], containing: string): string[] {
  const roots: string[] = [""];
  if (containing.length > 0) roots.push(containing);
  for (const root of provenRoots) if (!roots.includes(root)) roots.push(root);
  let dir = fromDir === "." ? "" : fromDir;
  while (dir.length > 0) {
    if (!roots.includes(dir)) roots.push(dir);
    const parent = posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
  return roots;
}

/**
 * A module path with the root already applied, decided by membership: module
 * file, then package `__init__.py`, then namespace directory.
 *
 * A DIRECTORY is not a legal file-edge target: `cg_symbols_edges_file` would
 * store it (the column has no FK), but it joins no row in `cg_symbols_files`,
 * so it adds fanIn to nothing and only inflates the source's fanOut — the same
 * phantom in a different costume. It is still a POSITIVE answer about the root,
 * which is why `namespace` and `miss` are different verdicts: the first stops
 * the root scan, the second continues it. Follow-up bead: attribute a namespace
 * import to its member files.
 */
function probePath(dir: string, table: GlobalSymbolTable): ImportPathProbe {
  if (dir.length === 0) return MISS;
  const moduleFile = `${dir}.py`;
  if (table.hasFile(moduleFile)) return { kind: "project", relPath: moduleFile };
  const packageInit = `${dir}/__init__.py`;
  if (table.hasFile(packageInit)) return { kind: "project", relPath: packageInit };
  return table.hasFilesUnder(dir) ? NAMESPACE : MISS;
}
