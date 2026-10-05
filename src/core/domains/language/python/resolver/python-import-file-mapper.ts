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

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, GlobalSymbolTable, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";
import { RunScopedMemo } from "../../kernel/index.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";
import { pythonModuleValueKey } from "../walker/passes/python-type-channels.js";
import { pythonClassKey } from "./python-class-key.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

/** The suffix that makes a directory a package; `pkg/__init__.py` -> `pkg/`. */
const INIT_PY = "/__init__.py";

const EXTERNAL: ImportFileTarget = { kind: "external" };
const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/** What one root said about one module path. `miss` alone lets the scan move on. */
type ImportPathProbe = { kind: "project"; relPath: RelPath } | { kind: "namespace" } | { kind: "miss" };

const NAMESPACE: ImportPathProbe = { kind: "namespace" };
const MISS: ImportPathProbe = { kind: "miss" };

/**
 * The TABLE-scoped half of the memo: every answer derived from symbol-table
 * MEMBERSHIP alone. Keyed by table identity beneath `ctx.runScope` and
 * invalidated when `size()` moves — pass 1 grows the table, pass 2 does not.
 * The scope is what retires a pooled table's answers once its content moved
 * without its size moving (bd tea-rags-mcp-39xca.6).
 *
 * `answers` belongs here rather than in the run half (bd tea-rags-mcp-11qqk):
 * `mapImportToFile` reads `ctx` for the symbol table and for nothing else, so
 * the same import text from the same directory against the same table names the
 * same file whatever a run happens to re-export.
 *
 * `roots` is the ordered set of source roots, SEEDED from the table's file set
 * when it can list one (bd tea-rags-mcp-60nss) and fixed for the generation.
 * It is never extended by what one caller's import happened to find: a root is
 * a `sys.path` entry, a property of the project, and a directory that answered
 * one caller's import proves nothing for the next (bd tea-rags-mcp-m99j1.1.31).
 * `containingRoots` memoises, per `fromDir`, the seeded root that contains it
 * (bd tea-rags-mcp-hg427); `scriptRoots` the caller's package-free ancestors
 * (see {@link scriptRootsOf}). Both are functions of `fromDir` alone, so each
 * costs one scan per directory rather than one per import.
 * `answers` is keyed by `<dir> <importText>` because the same text resolves
 * differently from two directories — every relative import, and any absolute
 * one whose candidate roots depend on where the caller sits.
 */
interface ImportMapperTableMemo {
  size: number;
  roots: string[];
  containingRoots: Map<string, string>;
  scriptRoots: Map<string, string[]>;
  answers: Map<string, ImportFileTarget>;
}

/**
 * The RUN-scoped half (bd tea-rags-mcp-11qqk): the two answers computed FROM
 * `ctx.moduleReexports`, which is a RUN-global channel and not a property of
 * the table.
 *
 * Keyed by `ctx.runScope` and, beneath it, the IDENTITY of that channel (bd
 * tea-rags-mcp-39xca.6). The channel alone was not the run:
 * `CodegraphRunState#absorb` replaces a re-walked file's entry on the SAME
 * object. Keying these two by the TABLE was the original defect: the
 * provider outlives a run (`LanguageFactory` caches it) and so does the table
 * (`GraphDbClientPool` keeps one per collection), so an `__init__.py` whose
 * re-export target moved without adding or removing a symbol kept resolving
 * through the previous run's declarer. The same shape
 * `PythonNamingConventionSymbolResolutionStrategy#descendantsOf` already uses
 * for `classAncestors`.
 *
 * `table` and `size` stamp the generation these answers were computed against.
 * Not a link to {@link ImportMapperTableMemo} — a validity stamp of its own,
 * and a necessary one: both answers ALSO read membership (`declaresName`, and
 * `mapImportToFile` for every hop), so a cold pass-1 refusal must not outlive
 * the growth that turns it into a hit.
 */
interface ImportMapperRunMemo {
  table: GlobalSymbolTable;
  size: number;
  /** `<file> <name>` -> the file that DECLARES it, or `null` for "cannot tell". */
  declarers: Map<string, RelPath | null>;
  /** `<file> <name>` -> the file the package ALIASES it to as a module, or `null`. */
  moduleAliases: Map<string, RelPath | null>;
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
  private readonly tableMemos = new RunScopedMemo<GlobalSymbolTable, ImportMapperTableMemo>();
  private readonly runMemos = new RunScopedMemo<object, ImportMapperRunMemo>();
  /**
   * The run key for a context carrying NO re-export channel — a non-Python run
   * reaching a shared strategy, and most unit tests. Per-mapper rather than
   * global, and memoising rather than skipping: with no channel to read there is
   * nothing run-dependent to leak, and the generation stamp still invalidates it
   * when the table moves.
   */
  private readonly channellessRunKey: object = {};

  mapImportToFile(importText: string, fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const head = importText.split(/\s+as\s+/)[0].trim();
    if (head.length === 0) return UNKNOWN;

    const table = ctx.symbolTable;
    const memo = this.tableMemoFor(ctx);
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
    const memo = this.runMemoFor(ctx);
    const key = `${relPath} ${name}`;
    const cached = memo.declarers.get(key);
    if (cached !== undefined) return cached;
    const answer = this.followReexports(relPath, name, ctx, 0, new Set([relPath]));
    memo.declarers.set(key, answer);
    return answer;
  }

  /**
   * The `moduleValueTypes` key of the module-scope VALUE `name` denotes when
   * imported from `relPath`, or `null` (P4, bd tea-rags-mcp-m99j1.1.15).
   *
   * {@link PythonImportFileMapper.resolveExportedName}'s walk with a different
   * terminator: not a file that DECLARES a symbol — a value is no symbol — but
   * a file whose module scope binds a typed value under the name.
   * `from django.apps import apps` maps to `django/apps/__init__.py`, which
   * re-exports `apps` from `.registry`, where `apps = Apps(...)` is the fact.
   * Same hop budget, same cycle guard, same star unanimity; the answer carries
   * the SOURCE spelling, so an `as` alias lands on the name the declaring file
   * actually bound. Not memoized: every hop is a map read plus a memoized
   * `mapImportToFile`.
   */
  resolveExportedValue(relPath: RelPath, name: string, ctx: CallContext): string | null {
    const values = ctx.moduleValueTypes;
    if (values === undefined || name.length === 0 || name === "*") return null;
    return this.followReexportChain(relPath, name, ctx, 0, new Set([relPath]), (file, bound) => {
      const key = pythonModuleValueKey(file, bound);
      return identifierEntry(values, key) === undefined ? null : key;
    });
  }

  /**
   * The class key (`<relPath>::<name>`) of the declaration `name` denotes when
   * imported from `relPath`, or `null` (bd tea-rags-mcp-m99j1.1.42).
   *
   * {@link PythonImportFileMapper.resolveExportedName}'s walk, answering with
   * the SOURCE spelling beside the file: `from .response import HttpResponse as
   * Resp` re-exports `Resp`, and the declaration it reaches is `HttpResponse`.
   * Same hop budget, cycle guard and star unanimity. Not memoized: the
   * known-target barrier asks once per distinct candidate.
   */
  resolveExportedClassKey(relPath: RelPath, name: string, ctx: CallContext): string | null {
    if (name.length === 0 || name === "*") return null;
    return this.followReexportChain(relPath, name, ctx, 0, new Set([relPath]), (file, bound) =>
      declaresName(file, bound, ctx) ? pythonClassKey(file, bound) : null,
    );
  }

  /** One hop of {@link PythonImportFileMapper.resolveExportedName}; see its contract. */
  private followReexports(
    relPath: RelPath,
    name: string,
    ctx: CallContext,
    depth: number,
    visited: Set<RelPath>,
  ): RelPath | null {
    return this.followReexportChain(relPath, name, ctx, depth, visited, (file, bound) =>
      declaresName(file, bound, ctx) ? file : null,
    );
  }

  /**
   * The re-export walk {@link resolveExportedName} and {@link resolveExportedValue}
   * share; `terminal` is what ends it, and what it answers.
   */
  private followReexportChain(
    relPath: RelPath,
    name: string,
    ctx: CallContext,
    depth: number,
    visited: Set<RelPath>,
    terminal: (relPath: RelPath, name: string) => string | null,
  ): string | null {
    const here = terminal(relPath, name);
    if (here !== null) return here;
    if (depth >= MAX_REEXPORT_HOPS) return null;
    const entries = identifierEntry(ctx.moduleReexports, relPath);
    if (entries === undefined) return null;
    for (const entry of entries) {
      if (entry.exportedName !== name || entry.sourceName === undefined) continue;
      const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
      if (source === null) continue;
      const hit = this.followReexportChain(source, entry.sourceName, ctx, depth + 1, visited, terminal);
      if (hit !== null) return hit;
    }
    // Stars, unanimous or not at all.
    let only: string | null = null;
    for (const entry of entries) {
      if (entry.exportedName !== "*") continue;
      const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
      if (source === null) continue;
      const hit = this.followReexportChain(source, name, ctx, depth + 1, visited, terminal);
      if (hit === null) continue;
      if (only !== null && only !== hit) return null;
      only = hit;
    }
    return only;
  }

  /**
   * Which FILE the package at `relPath` binds `name` to as a MODULE, or `null`
   * (bd tea-rags-mcp-w205u, E4.6a).
   *
   * {@link PythonImportFileMapper.resolveExportedName} answers "which file
   * DECLARES this name" and requires a SYMBOL to exist. A package that writes
   * `from . import _datatable as datatable` declares no symbol at all: the name
   * denotes a sibling MODULE, and the answer is that module's file. polar's
   * `server/polar/backoffice/components/__init__.py` is that shape and 259 call
   * sites read a member off it.
   *
   * Same channel (`ctx.moduleReexports`), same hop budget, same cycle guard,
   * different terminator — a file rather than a declaration. Deterministic
   * throughout: an explicit alias names exactly ONE module, so there is nothing
   * to pick between. Stars carry no `sourceName` and are skipped rather than
   * dereferenced; a star re-exports NAMES, and which module a starred name came
   * from is `resolveExportedName`'s unanimity question, not this one.
   */
  resolveExportedModule(relPath: RelPath, name: string, ctx: CallContext): RelPath | null {
    if (name.length === 0 || name === "*") return null;
    const memo = this.runMemoFor(ctx);
    const key = `${relPath} ${name}`;
    const cached = memo.moduleAliases.get(key);
    if (cached !== undefined) return cached;
    const answer = this.followModuleAlias(relPath, name, ctx, 0, new Set([relPath]));
    memo.moduleAliases.set(key, answer);
    return answer;
  }

  /** One hop of {@link PythonImportFileMapper.resolveExportedModule}; see its contract. */
  private followModuleAlias(
    relPath: RelPath,
    name: string,
    ctx: CallContext,
    depth: number,
    visited: Set<RelPath>,
  ): RelPath | null {
    if (depth >= MAX_REEXPORT_HOPS) return null;
    const entries = identifierEntry(ctx.moduleReexports, relPath);
    if (entries === undefined) return null;
    for (const entry of entries) {
      if (entry.exportedName !== name || entry.sourceName === undefined) continue;
      // Composed exactly as `receiverModuleText` composes, so `.` + `_datatable`
      // is `._datatable` and never `.._datatable` — a leading-dot module text
      // that gained a separator would climb a package.
      const text = entry.sourceModule.endsWith(".")
        ? `${entry.sourceModule}${entry.sourceName}`
        : `${entry.sourceModule}.${entry.sourceName}`;
      const direct = this.mapImportToFile(text, relPath, ctx);
      if (direct.kind === "project" && !visited.has(direct.relPath)) return direct.relPath;
      // The alias points at another PACKAGE that aliases further.
      const source = this.stepToSource(relPath, entry.sourceModule, ctx, visited);
      if (source === null) continue;
      const hit = this.followModuleAlias(source, entry.sourceName, ctx, depth + 1, visited);
      if (hit !== null) return hit;
    }
    return null;
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

  private tableMemoFor(ctx: CallContext): ImportMapperTableMemo {
    const table = ctx.symbolTable;
    const existing = this.tableMemos.get(ctx.runScope, table);
    const size = table.size();
    // A grown table can turn `external` into `project`; a stale memo would
    // freeze the cold-pass answer for the whole run.
    if (existing?.size === size) return existing;
    const fresh: ImportMapperTableMemo = {
      size,
      roots: seedRoots(table),
      containingRoots: new Map(),
      scriptRoots: new Map(),
      answers: new Map(),
    };
    this.tableMemos.set(ctx.runScope, table, fresh);
    return fresh;
  }

  /**
   * The memo for the RUN this context belongs to; see
   * {@link ImportMapperRunMemo} for why the channel's identity is the run.
   */
  private runMemoFor(ctx: CallContext): ImportMapperRunMemo {
    const table = ctx.symbolTable;
    const size = table.size();
    const key = ctx.moduleReexports ?? this.channellessRunKey;
    const existing = this.runMemos.get(ctx.runScope, key);
    if (existing?.table === table && existing.size === size) return existing;
    const fresh: ImportMapperRunMemo = { table, size, declarers: new Map(), moduleAliases: new Map() };
    this.runMemos.set(ctx.runScope, key, fresh);
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
 * Why the caller's ancestors cannot stand in for this: they only ever name a
 * root the importing file sits UNDER. flask's `examples/app.py` imports `flask`
 * absolutely and `src` is nobody's ancestor there, so the old ancestor scan
 * exhausted and 15 bare calls fell out `external` — and whether it exhausted
 * depended on walk order, since visiting `src/flask/app.py` first happened to
 * prove `src` lazily.
 *
 * Sorted DEEPEST first, then lexicographically: a nested root must not be
 * shadowed by the one above it, and it makes the answer independent of the
 * order files entered the table.
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
 * `""`, then the seeded root CONTAINING the caller, then the remaining seeded
 * roots, then the caller's own SCRIPT roots (see {@link scriptRootsOf}).
 *
 * Every candidate is a directory that can be a `sys.path` entry, which is the
 * only place Python 3 looks for an absolute import (PEP 328 retired the
 * implicit relative one). The scan this replaced offered EVERY ancestor of the
 * caller, packages included, and a package is never on `sys.path`: polar's
 * `import jwt` inside `server/polar/kit/jwt.py` answered with the caller's own
 * file, `import logfire` with `server/polar/logfire.py`, `import stripe` with
 * `polar/integrations/stripe/__init__.py`, and flask's `import typing` with
 * `src/flask/typing.py` — each a library or the stdlib (bd
 * tea-rags-mcp-m99j1.1.31). Measured on the six corpora, every row that scan
 * answered from a package ancestor was one of those; the one legitimate shape
 * it served, polar's package-free `dev/cli/` scripts, is what script roots keep.
 *
 * Deepest-first among the seeded roots is load-bearing. netbox holds both
 * `netbox/netbox/settings.py` and the outer `netbox/` directory; a
 * shallow-first order would let the outer one shadow the inner package for
 * `netbox.settings`.
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
  memo: ImportMapperTableMemo,
): ImportFileTarget {
  const segments = head.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return UNKNOWN;
  const modulePath = segments.join("/");

  for (const root of candidateRoots(fromDir, table, memo)) {
    const probe = probePath(root.length === 0 ? modulePath : `${root}/${modulePath}`, table);
    if (probe.kind === "miss") continue;
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
 * The deepest seeded root that contains `fromDir`, or `""` for none.
 *
 * `""` doubles as the "none" answer because hoisting it would be a no-op: the
 * repo root is already `candidateRoots`' first candidate.
 *
 * The seeded roots are sorted deepest-first, so the FIRST containing root is
 * the deepest — two roots at the same depth cannot both be ancestors of one
 * directory. Containment is tested on a separator boundary, so `server` does
 * not swallow `server-tools/x.py`, and a file sitting directly in the root
 * counts as contained.
 */
function containingSeededRoot(fromDir: string, memo: ImportMapperTableMemo): string {
  const cached = memo.containingRoots.get(fromDir);
  if (cached !== undefined) return cached;
  let containing = "";
  for (const root of memo.roots) {
    if (root.length === 0) continue;
    if (fromDir === root || fromDir.startsWith(`${root}/`)) {
      containing = root;
      break;
    }
  }
  memo.containingRoots.set(fromDir, containing);
  return containing;
}

/** `""`, the caller's own seeded root, the remaining seeded roots, then its script roots. */
function candidateRoots(fromDir: string, table: GlobalSymbolTable, memo: ImportMapperTableMemo): string[] {
  const containing = containingSeededRoot(fromDir, memo);
  const roots: string[] = [""];
  if (containing.length > 0) roots.push(containing);
  for (const root of memo.roots) if (!roots.includes(root)) roots.push(root);
  for (const root of scriptRootsOf(fromDir, table, memo)) if (!roots.includes(root)) roots.push(root);
  return roots;
}

/**
 * The caller's ancestors that can be a SCRIPT's `sys.path` entry, deepest
 * first — or none.
 *
 * A file run as a script puts its own directory on `sys.path`, and a tool that
 * inserts its directory by hand does the same for the scripts beneath it:
 * polar's `dev/cli/cli.py` runs `sys.path.insert(0, CLI_DIR)`, and
 * `dev/cli/commands/*.py` then write `import shared` for `dev/cli/shared.py`.
 * No `__init__.py` exists anywhere in that tree, so no package names a seeded
 * root there.
 *
 * Admitted only ABOVE the outermost regular package on the caller's chain. A
 * directory holding `__init__.py` is a package and every directory under it is
 * package territory — a module, never a `sys.path` entry — so meeting one
 * discards everything collected below it. What survives above it is a
 * directory no package encloses: a seeded root already, or the parent of a PEP
 * 420 namespace package that seeding cannot see (a top-level `polar/` without
 * `__init__.py` makes `server/polar` look like a root and hides `server`).
 */
function scriptRootsOf(fromDir: string, table: GlobalSymbolTable, memo: ImportMapperTableMemo): string[] {
  const cached = memo.scriptRoots.get(fromDir);
  if (cached !== undefined) return cached;
  const chain: string[] = [];
  let dir = fromDir === "." ? "" : fromDir;
  while (dir.length > 0) {
    if (table.hasFile(`${dir}${INIT_PY}`)) chain.length = 0;
    else chain.push(dir);
    const parent = posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
  memo.scriptRoots.set(fromDir, chain);
  return chain;
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
