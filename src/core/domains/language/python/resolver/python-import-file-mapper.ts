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
 */

import { posix } from "node:path";

import type { CallContext, GlobalSymbolTable, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";
import { PYTHON_STDLIB_MODULES } from "../vocabulary/stdlib-modules.js";

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
 * `roots` is the ordered set of roots already proven to fit: on a corpus with
 * one source root, the second import onward skips most of the ancestor scan.
 * `answers` is keyed by `<dir> <importText>` because the same text resolves
 * differently from two directories — every relative import, and any absolute
 * one whose root inference depends on the caller's ancestors.
 */
interface ImportMapperMemo {
  size: number;
  roots: string[];
  answers: Map<string, ImportFileTarget>;
}

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

  private memoFor(table: GlobalSymbolTable): ImportMapperMemo {
    const existing = this.memos.get(table);
    const size = table.size();
    // A grown table can turn `external` into `project`; a stale memo would
    // freeze the cold-pass answer for the whole run.
    if (existing?.size === size) return existing;
    const fresh: ImportMapperMemo = { size, roots: [], answers: new Map() };
    this.memos.set(table, fresh);
    return fresh;
  }
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
 * `""`, then the memo's proven ones, then the importing file's ancestors
 * DEEPEST to SHALLOWEST.
 *
 * Deepest-first is load-bearing. netbox holds both `netbox/netbox/settings.py`
 * and the outer `netbox/` directory; a shallow-first ancestor scan would let
 * the outer one shadow the inner package for `netbox.settings`.
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

  for (const root of candidateRoots(fromDir, memo.roots)) {
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

/** `""`, then memo-proven roots, then the caller's ancestors deepest-first. */
function candidateRoots(fromDir: string, provenRoots: readonly string[]): string[] {
  const roots: string[] = [""];
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
