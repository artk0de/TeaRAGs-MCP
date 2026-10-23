/**
 * Decodes the rustc call-site driver's NDJSON unit files into the call-site →
 * definition lookup the Rust chain's SCIP slot reads (bd s3i8m T5; contract and
 * row mapping: research/rustc-driver/SPEC.md §3, macro spans §4).
 *
 * The answer is the `RustCallSiteIndex` port: the SCIP definition shape plus
 * `implIsDerived`, the one fact SCIP cannot carry.
 *
 * Rules:
 * - Rows are deduped on `(relPath, line, col, callee)` — units of one package
 *   (lib, bin, test harness) re-emit the same sites.
 * - `origin: "macro"` rows are never served: their position is the macro name
 *   token, which a call the macro BODY makes cannot be bound to.
 * - `origin: "macroInvocation"` rows (RESIDUAL.md R3) are served at that name
 *   token as a `kind: "macro"` definition — the invoked macro's own definition
 *   (`macroDefPath`), in the project for a workspace `macro_rules!`, else external.
 * - An indirect `callKind: "local"` row (RESIDUAL.md R4: no `calleeCrate`, a
 *   closure / fn pointer / Fn-bound param callee) is served as a `kind: "local"`
 *   definition carrying `indirectCallee` — nothing defined, nothing external.
 *   A local binding of a fn item names its crate and decodes like any row.
 * - Two NON-identical source rows on one position (a different callee, or the
 *   same callee resolved differently by two units) are ambiguous: the position
 *   answers null rather than picking one.
 * - A derived impl (`implIsDerived`) answers `inProject: false` with the
 *   package still a workspace crate, and carries `implIsDerived: true`.
 * - Malformed lines are skipped; decoding never throws.
 *
 * Memory: tikv emits ~425k rows. Strings are interned once, each served row is
 * eight integers in one flat array, and each file keeps one `Map` from
 * position key to row offset. The `RustCallSiteDefinition` is built on lookup.
 */

import type {
  RustCallSiteDefinition,
  RustCallSiteIndex,
  RustIndirectCalleeKind,
} from "../../contracts/types/language.js";

/** Columns at or past this are never keyed (a minified line); one safe integer then keys line + column. */
const MAX_COLUMN = 0x100000;
/** Marks a position claimed by two non-identical rows. */
const AMBIGUOUS = -1;
const NONE = -1;
/** Ints per row in the flat store: callee, crate, resolvedImpl, traitPath, defRelPath, defLine, flags, kind. */
const STRIDE = 8;
const FLAG_IN_PROJECT = 1;
const FLAG_DERIVED_IMPL = 2;

/** Packed kind slot → the served `kind`, plus `indirectCallee` for the R4 slots. */
const KIND_SLOTS: readonly { kind: RustCallSiteDefinition["kind"]; indirectCallee?: RustIndirectCalleeKind }[] = [
  { kind: "callable" },
  { kind: "type" },
  { kind: "other" },
  { kind: "macro" },
  { kind: "local", indirectCallee: "closure" },
  { kind: "local", indirectCallee: "fnPointer" },
  { kind: "local", indirectCallee: "fnParam" },
];
const OTHER_SLOT = 2;
/** Row `defKind` → KIND_SLOTS index; anything unlisted is `other`. A macro invocation decodes as defKind `macro`. */
const DEF_KIND_INDEX: ReadonlyMap<string, number> = new Map([
  ["fn", 0],
  ["assocFn", 0],
  ["ctor", 1],
  ["macro", 3],
]);
/** An indirect row's `defKind` → KIND_SLOTS index; any other defKind on such a row is malformed. */
const INDIRECT_KIND_INDEX: ReadonlyMap<string, number> = new Map([
  ["closure", 4],
  ["fnPointer", 5],
  ["fnParam", 6],
]);
/** Origins whose position is the token they name; `macro` rows sit on the invocation's name token instead. */
const SERVED_ORIGINS: ReadonlySet<string> = new Set(["source", "macroInvocation"]);
const MACRO_INVOCATION = "macroInvocation";

export interface RustcCallSiteDecodeOptions {
  /** Crate names the driver ran on (workspace members). Callee crates of in-project, trait-free rows are added. */
  readonly workspaceCrates?: Iterable<string>;
}

/**
 * Build the lookup from the text of one or more unit NDJSON files.
 * `identity` is the runner's envKey + units digest, exposed unchanged.
 */
export function decodeRustcCallSites(
  unitTexts: Iterable<string>,
  identity: string,
  options: RustcCallSiteDecodeOptions = {},
): RustCallSiteIndex {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (value: string): number => {
    let index = stringIndex.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      stringIndex.set(value, index);
    }
    return index;
  };
  const rows: number[] = [];
  const byFile = new Map<string, Map<number, number>>();
  const workspaceCrates = new Set<string>(options.workspaceCrates ?? []);

  for (const text of unitTexts) {
    for (const line of lines(text)) {
      const row = parseRow(line);
      if (row === null) continue;
      // A trait method resolved to a project impl names the TRAIT's crate (`std` for
      // `io::Read::read`), so only a call with no trait proves its callee crate is ours.
      if (row.inProject && row.traitPath === null) workspaceCrates.add(row.calleeCrate);
      if (!SERVED_ORIGINS.has(row.origin) || row.col >= MAX_COLUMN) continue;
      const packed = pack(row, intern);
      let positions = byFile.get(row.relPath);
      if (positions === undefined) {
        positions = new Map();
        byFile.set(row.relPath, positions);
      }
      const key = positionKey(row.line, row.col);
      const existing = positions.get(key);
      if (existing === undefined) {
        positions.set(key, rows.length);
        rows.push(...packed);
      } else if (existing !== AMBIGUOUS && !sameRow(rows, existing, packed)) {
        positions.set(key, AMBIGUOUS);
      }
    }
  }

  return {
    identity,
    definitionAt: (relPath, line, utf16Col) => {
      if (utf16Col < 0 || utf16Col >= MAX_COLUMN || line < 1) return null;
      const offset = byFile.get(relPath)?.get(positionKey(line, utf16Col));
      if (offset === undefined || offset === AMBIGUOUS) return null;
      return describe(rows, offset, strings, workspaceCrates);
    },
  };
}

interface ParsedRow {
  relPath: string;
  line: number;
  col: number;
  origin: string;
  /** An R4 indirect callee: no crate, no definition, the defKind names the indirection. */
  indirect: boolean;
  callee: string;
  calleeCrate: string;
  defKind: string;
  traitPath: string | null;
  resolvedImpl: string | null;
  implIsDerived: boolean;
  inProject: boolean;
  defRelPath: string | null;
  defLine: number | null;
}

function* lines(text: string): Iterable<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (end > start) yield text.slice(start, end);
    start = end + 1;
  }
}

function parseRow(line: string): ParsedRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // A macro invocation names its macro's definition: the callee is the macro's def path.
  const invocation = r.origin === MACRO_INVOCATION;
  // An indirect callee (a closure, fn pointer or Fn-bound param binding) has no crate.
  const indirect = !invocation && r.callKind === "local" && r.calleeCrate === null;
  const { relPath, line: lineNo, col, origin } = r;
  const calleeCrate = indirect ? "" : r.calleeCrate;
  const callee = invocation ? r.macroDefPath : r.callee;
  const defKind = invocation ? "macro" : r.defKind;
  if (typeof relPath !== "string" || typeof origin !== "string") return null;
  if (typeof callee !== "string" || typeof calleeCrate !== "string" || typeof defKind !== "string") return null;
  if (indirect && !INDIRECT_KIND_INDEX.has(defKind)) return null;
  if (!Number.isInteger(lineNo) || (lineNo as number) < 1) return null;
  if (!Number.isInteger(col) || (col as number) < 0) return null;
  const defLine = Number.isInteger(r.defLine) ? (r.defLine as number) : null;
  return {
    relPath,
    line: lineNo as number,
    col: col as number,
    origin,
    indirect,
    callee,
    calleeCrate,
    defKind,
    traitPath: typeof r.traitPath === "string" ? r.traitPath : null,
    resolvedImpl: typeof r.resolvedImpl === "string" ? r.resolvedImpl : null,
    implIsDerived: r.implIsDerived === true,
    inProject: r.inProject === true,
    defRelPath: typeof r.defRelPath === "string" ? r.defRelPath : null,
    defLine,
  };
}

function pack(row: ParsedRow, intern: (value: string) => number): number[] {
  const served = row.inProject && !row.implIsDerived && row.defRelPath !== null && row.defLine !== null;
  const kind = (row.indirect ? INDIRECT_KIND_INDEX : DEF_KIND_INDEX).get(row.defKind) ?? OTHER_SLOT;
  return [
    intern(row.callee),
    intern(row.calleeCrate),
    row.resolvedImpl === null ? NONE : intern(row.resolvedImpl),
    row.traitPath === null ? NONE : intern(row.traitPath),
    served && row.defRelPath !== null ? intern(row.defRelPath) : NONE,
    served ? (row.defLine ?? 0) : 0,
    (served ? FLAG_IN_PROJECT : 0) | (row.implIsDerived ? FLAG_DERIVED_IMPL : 0),
    kind,
  ];
}

function sameRow(rows: readonly number[], offset: number, packed: readonly number[]): boolean {
  for (let i = 0; i < STRIDE; i++) if (rows[offset + i] !== packed[i]) return false;
  return true;
}

function describe(
  rows: readonly number[],
  offset: number,
  strings: readonly string[],
  workspaceCrates: ReadonlySet<string>,
): RustCallSiteDefinition {
  const at = (field: number): number => rows[offset + field] ?? NONE;
  const text = (field: number): string | undefined => (at(field) === NONE ? undefined : strings[at(field)]);
  const callee = text(0) ?? "";
  const calleeCrate = text(1) ?? "";
  const resolvedImpl = text(2);
  const traitName = lastSegment(text(3));
  const slot = KIND_SLOTS[at(7)] ?? KIND_SLOTS[OTHER_SLOT];
  if (slot.indirectCallee !== undefined) {
    return {
      symbol: `rustc local ${slot.indirectCallee} ${callee}`,
      package: "",
      inProject: false,
      name: callee,
      kind: slot.kind,
      packageInProject: false,
      indirectCallee: slot.indirectCallee,
    };
  }
  const base = {
    symbol: `rustc ${calleeCrate} ${resolvedImpl ?? callee}`,
    package: calleeCrate,
    name: lastSegment(callee) ?? "",
    kind: slot.kind,
    packageInProject: workspaceCrates.has(calleeCrate),
    ...(traitName !== undefined && resolvedImpl !== undefined ? { implTrait: traitName } : {}),
    ...(traitName !== undefined && resolvedImpl === undefined ? { declaringTrait: traitName } : {}),
    ...((at(6) & FLAG_DERIVED_IMPL) === 0 ? {} : { implIsDerived: true }),
  };
  if ((at(6) & FLAG_IN_PROJECT) === 0) return { ...base, inProject: false };
  return { ...base, inProject: true, relPath: text(4) ?? "", line: at(5) };
}

/** Last `::` segment at generic depth 0, trailing generic args stripped: `a::Vec::<T, E>::map_err` → `map_err`. */
function lastSegment(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  let end = path.length;
  while (end > 0 && path[end - 1] === ">") {
    let depth = 0;
    let i = end - 1;
    for (; i >= 0; i--) {
      if (path[i] === ">") depth++;
      else if (path[i] === "<" && --depth === 0) break;
    }
    if (i < 0) break;
    end = i;
    if (path.endsWith("::", end)) end -= 2;
  }
  let depth = 0;
  for (let i = end - 1; i >= 1; i--) {
    const c = path[i];
    if (c === ">") depth++;
    else if (c === "<") depth--;
    else if (c === ":" && path[i - 1] === ":" && depth === 0) return path.slice(i + 1, end);
  }
  return path.slice(0, end);
}

function positionKey(line: number, col: number): number {
  return line * MAX_COLUMN + col;
}
