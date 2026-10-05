/**
 * Codegraph lookup-table dispatch contracts — the const dispatch tables a
 * walker captures (`DispatchTable`, `DispatchTableDef`), the call-site
 * reference into them (`DispatchRef`), the fan-out edges a resolver expands
 * them to (`DispatchEdge`), and the corpus-adaptive cap that decides whether a
 * fan-out is materialized as edges or reported as ambiguous
 * (`DispatchFanoutPolicy`, `DispatchFanoutOutcome`).
 *
 * One concern end to end: capture → reference → bounded expansion. Re-exported
 * verbatim by the `codegraph.ts` barrel.
 */

import type { MethodEdgeKind } from "./codegraph-graph.js";
import type { RelPath, SymbolId } from "./codegraph-symbols.js";

/**
 * A const dispatch table defined in one file (bd tea-rags-mcp-n0zj).
 * `entries` preserves the source key→value mapping so a static
 * string-literal key (`TABLE["ts"]`) resolves to the ONE matching entry
 * while a dynamic key (`TABLE[ext]`) fans out to ALL of them. The value
 * is either a function name (S2 direct-function map `{ k: fn }`) or a
 * `fieldName → fnName` map (S1 wrapper-object map `{ k: { field: fn } }`).
 * Only entries / fields whose value is a plain identifier are recorded —
 * inline arrows, spreads, and computed values carry no symbol to point at
 * and are dropped (m46z safety rule).
 *
 * Ruby registry overload (bd tea-rags-mcp-pq02v): for a frozen registry
 * constant (`CONST = { "k" => A::B::Klass }.freeze`) the string-arm entry
 * value is a CLASS fully-qualified name (not a function name), and the
 * dispatched member comes from the call site's `DispatchRef.field`
 * (`CONST[k].new.perform` → `field: "perform"`), NOT from the entry. The
 * resolver interprets the entry per language (it is language-scoped), so the
 * overload is type-safe without a shape change.
 */
export interface DispatchTable {
  entries: Record<string, DispatchTableEntry>;
}

/**
 * One `DispatchTable` value: a callable / class spelling (S2, Ruby registry)
 * or a `fieldName → spelling` wrapper object (S1). The language reading it
 * decides which shape it accepts.
 */
export type DispatchTableEntry = string | Record<string, string>;

/**
 * A `DispatchTable` paired with the repo-relative path of the file that
 * declared it. The run-global aggregate keys these by table NAME (a name
 * may be declared in more than one file), so the resolver disambiguates
 * by the caller's import map before binding — and drops rather than
 * guesses when the name is ambiguous across files with no import edge.
 */
export interface DispatchTableDef {
  relPath: RelPath;
  table: DispatchTable;
}

/**
 * A reference to a dispatch candidate set, emitted by the walker and
 * resolved by the resolver against the run-global tables.
 *   - `field: null`  ⇒ S2: the entry IS the function (call `TABLE[k](x)`).
 *   - `field: "fn"`  ⇒ S1: select that field of the entry object.
 *   - `key: null`    ⇒ dynamic key: fan out to ALL entries.
 *   - `key: "ts"`    ⇒ static string-literal key: the ONE matching entry.
 */
export interface DispatchRef {
  table: string;
  field: string | null;
  key: string | null;
  /**
   * Ruby registry overload (bd tea-rags-mcp-exmwr): the call SHAPE that reached
   * `field`. `true` ⇒ the chain passed through an instantiator
   * (`CONST[k].new.m`), so `field` names an INSTANCE member (`Class#field`);
   * `false` ⇒ the member is invoked on the value CLASS itself
   * (`CONST[k].create!` → `Class.field`). Omitted by table dispatch that has no
   * receiver-form distinction (the TypeScript tables select a FUNCTION name, not
   * a member of a receiver), where it reads as "not applicable".
   */
  viaInstance?: boolean;
}

/**
 * One site that passes a FUNCTION REFERENCE into a parameter (P2 callable-value
 * flow, bd tea-rags-mcp-m99j1.1.19): `register(handler)`, or a decorator
 * `@csrf_exempt def v` read as the implicit call `csrf_exempt(v)`. Stored under
 * `FileExtraction.callableArgSources["<relPath>::<callee member>"]`, so the key
 * names the PASSING file and the callee's short name; this record carries the
 * rest of the site.
 *
 * Both spellings are as the passing file's module scope sees them: the walker
 * records an argument only when no enclosing def binds its head name, so the
 * resolver reads `argument` (`v`, `Cls.method`) and `calleeReceiver` (a module
 * alias, or `null` for a bare callee) from that file's imports and
 * declarations. A source set is a LOWER bound — a callable passed through a
 * local, a lambda or a keyword is not recorded — never a guess.
 */
export interface CallableArgSource {
  /** The callee's qualifier as written (`decorators` in `decorators.csrf_exempt(f)`), `null` for a bare name. */
  calleeReceiver: string | null;
  /** CALL-SITE position of the argument — the same numbering `callbackParams` uses. */
  argIndex: number;
  /** The function passed, spelled from the passing file's module scope: `v` or `Cls.method`. */
  argument: string;
}

/**
 * One fan-out edge produced by dispatch / callback-param resolution.
 * `sourceSymbolId: null` ⇒ the edge originates from the calling chunk
 * (the provider fills in the caller's symbolId). A non-null
 * `sourceSymbolId` OVERRIDES the source — used by the bounded
 * inter-procedural join where the edge originates from the CALLEE that
 * invokes the passed-in callback, not from the call site.
 */
export interface DispatchEdge {
  sourceSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  targetSymbolId: SymbolId | null;
  /**
   * Method-edge kind for CHA cone fan-out (bd tea-rags-mcp-2jet). Omitted for
   * the legacy lookup-table / callback fan-outs, which the provider persists as
   * `'exact'`. The Ruby cone resolver sets `'cone'` (one of N equal candidates)
   * or `'poly-base'` (capped hub edge, query-time expanded).
   */
  edgeKind?: MethodEdgeKind;
  /**
   * Per-edge confidence in `(0, 1]` (bd tea-rags-mcp-2jet). `1/N` for a `cone`
   * edge sharing unit weight across N candidates; `1.0` for `poly-base` and the
   * legacy fan-outs (provider default when omitted).
   */
  confidence?: number;
}

/**
 * Corpus-adaptive bound on dispatch fan-out (bd tea-rags-mcp-f2jsb). Built once
 * per GlobalSymbolTable from the defs-per-shortName distribution: `cap` is the
 * p99 of that distribution floored at DISPATCH_FANOUT_CAP_FLOOR. A fan-out with
 * more survivors than `cap` carries no per-target information (confidence
 * `discount/m` is below noise) and is reported as an ambiguous outcome instead
 * of materialized edges.
 */
export interface DispatchFanoutPolicy {
  /** Max survivors a dispatch fan-out may materialize as edges. */
  cap: number;
  /** Diagnostic: the corpus p99 of defs-per-shortName the cap derives from. */
  p99DefsPerMember: number;
}

/**
 * Terminal outcome of a dispatch fan-out (bd tea-rags-mcp-f2jsb).
 *
 *   - `edges` — bounded fan-out, materialized as method edges (possibly empty:
 *     vocabulary suppression / zero candidates keep their existing semantics).
 *   - `ambiguous` — survivor count exceeded the corpus-adaptive
 *     DispatchFanoutPolicy cap: NO edges are emitted; the provider records an
 *     ambiguousFanout aggregate so recall reporting stays honest (strict vs
 *     covered) without flooding the graph.
 */
export type DispatchFanoutOutcome =
  | { kind: "edges"; edges: DispatchEdge[] }
  | { kind: "ambiguous"; member: string; candidateCount: number };

/** The neutral "no fan-out" outcome — a fresh object per call so consumers may
 *  push into `edges` without aliasing. */
export const emptyDispatchFanout = (): DispatchFanoutOutcome => ({ kind: "edges", edges: [] });
