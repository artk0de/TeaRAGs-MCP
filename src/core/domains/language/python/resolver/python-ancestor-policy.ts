/**
 * Python's ORDER half of the ancestor walk, as an
 * {@link AncestorLinearizationPolicy} the neutral kernel driver can call (bd
 * tea-rags-mcp-9fgdi / tea-rags-mcp-84db2).
 *
 * Two things live here and nothing else: turning the walker's import-qualified
 * base SPELLINGS (`a.b::Base`, `.base::Base`, `django.db::Model`, bare `Base`)
 * into project class KEYS, and running `linearizeC3` over them. The recursion
 * driver, the per-run memo and the member scan belong to
 * `kernel/ancestor-walk.ts`; the C3 merge itself belongs to `./mro.ts`.
 *
 * DEVIATION from the plan's Task 3 shape, recorded deliberately: `order` does
 * NOT use the kernel's `recurse` / `insertable` closures. `linearizeC3` owns a
 * complete recursion with its own per-path cycle guard — that is the surface
 * IN.2 landed — so driving it a second time through the kernel's recursion
 * would mean either re-implementing the merge here or exporting `c3Merge`.
 * The kernel's `seen` set is therefore `{classKey}` alone, which is why
 * `boundaryOf` answers for the whole SUBTREE of the key it is handed rather
 * than for that one class: the kernel joins boundary verdicts over `seen`, and
 * `joinClosure` is monotone, so one subtree-wide verdict at the root is exactly
 * the answer a per-class join over the full walk would produce.
 *
 * Both halves come out of ONE memoized pass, because the closure is accumulated
 * inside the `basesOf` closure `linearizeC3` calls — the mechanism that module's
 * docblock prescribes.
 *
 * WHERE THE STAR-IMPORT SEAM LIVES (bd tea-rags-mcp-4yh64). A base bound by
 * `from m import *` reaches this module ALREADY spelled as a disjunction the
 * walker built, not as a bare name this module goes looking for. That is a
 * deliberate choice between two seams:
 *
 *   - resolving it here would need the DEFINING file's imports at MRO-build
 *     time, and nothing on the read path has them. `CallContext.imports` is the
 *     CALLER's list, and `PythonImportFileMapper` answers from symbol-table
 *     membership alone — no import lists at all. Reaching them would mean a new
 *     run-global per-file import channel threaded through the pass-1→pass-2
 *     barrier, for data pass 1 already held and threw away;
 *   - the walker holds the file's star modules while it is qualifying that very
 *     base, so `qualifyThroughStarImports` costs no channel. It writes the
 *     candidates; `resolveBaseKey` picks the one the symbol table confirms.
 *
 * The linearization is CALLER-INDEPENDENT: a base spelling carries its DEFINING
 * file's import binding, never the asking file's, so `MRO(RepositoryBase)` is
 * one order whichever call site wants it. That is what makes the per-run memo
 * sound, and it is why {@link PythonAncestorLinearizerCache} hands every
 * strategy the SAME linearizer for a run instead of building one per call site
 * (decision 7: netbox has ~3,600 classes and ~30,000 `self.` call sites).
 */

import type { AmbiguousResolveMode, CallContext, RelPath } from "../../../../contracts/types/codegraph.js";
import {
  createAncestorLinearizer,
  type AncestorClosure,
  type AncestorLinearizationPolicy,
  type AncestorLinearizer,
} from "../../kernel/ancestor-walk.js";
import { reexportOriginFile } from "../../kernel/reexport-origin.js";
import { PYTHON_BUILTINS } from "../vocabulary/builtins.js";
import { PYTHON_UNRESOLVABLE_BASE } from "../walker/walker.js";
import { linearizeC3 } from "./mro.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  lookupPythonSymbolsByShortName,
  parsePythonClassKey,
  pythonClassKey,
  pythonClassKeyIsDeclared,
  pythonDeclaredClassFq,
} from "./strategies/shared.js";

/** What a base SPELLING turned out to name. Mirrors the import mapper's three states. */
type BaseKeyVerdict = { readonly kind: "project"; readonly classKey: string } | { readonly kind: AncestorClosure };

const EXTERNAL_BASE: BaseKeyVerdict = { kind: "external" };
const UNKNOWN_BASE: BaseKeyVerdict = { kind: "unknown" };

const CLOSURE_RANK: Record<AncestorClosure, number> = { closed: 0, unknown: 1, external: 2 };

/** Precision-first join, the same ordering the kernel applies over its own `seen` set. */
function worse(a: AncestorClosure, b: AncestorClosure): AncestorClosure {
  return CLOSURE_RANK[b] > CLOSURE_RANK[a] ? b : a;
}

/** Python's ancestor policy, plus the fallback counter a gate has to be able to print. */
export interface PythonAncestorPolicy extends AncestorLinearizationPolicy<CallContext> {
  /**
   * How often C3 gave up and the left-to-right DFS fallback produced the order.
   * `0` is a true C3 linearization throughout; a silent fallback is an
   * unmeasured order, so the number is exposed rather than swallowed.
   */
  readonly linearizationFallbacks: number;
}

export function createPythonAncestorPolicy(
  mapper: PythonImportFileMapper,
  mode: AmbiguousResolveMode,
): PythonAncestorPolicy {
  const memo = new Map<string, { readonly order: readonly string[]; readonly closure: AncestorClosure }>();
  let fallbacks = 0;

  const compute = (classKey: string, ctx: CallContext): { order: readonly string[]; closure: AncestorClosure } => {
    const hit = memo.get(classKey);
    if (hit !== undefined) return hit;
    let closure: AncestorClosure = "closed";
    const basesOf = (key: string): readonly string[] => {
      const parsed = parsePythonClassKey(key);
      const spellings = ctx.classAncestors?.[key];
      if (parsed === null || spellings === undefined) {
        // No hierarchy recorded under this key — two different facts wearing
        // one shape (bd tea-rags-mcp-graiw). A class the run DECLARES and the
        // walker recorded no base for is a real leaf, and a member missing
        // under it is evidence of ABSENCE: the closure stays `closed`. A key
        // nothing declares carries no evidence either way, and reading it
        // `closed` is what let a mis-spelled enclosing-class key DROP a call
        // and suppress `super()`'s pre-seam `classExtends` fallback.
        if (parsed !== null && !pythonClassKeyIsDeclared(key, ctx)) closure = worse(closure, "unknown");
        return [];
      }
      const keys: string[] = [];
      for (const spelling of spellings) {
        const verdict = resolveBaseKey(spelling, parsed.relPath, ctx, mapper, mode);
        if (verdict.kind === "project") keys.push(verdict.classKey);
        else closure = worse(closure, verdict.kind);
      }
      return keys;
    };
    const outcome = linearizeC3(classKey, basesOf);
    fallbacks += outcome.fallbacks;
    const result = { order: outcome.order, closure };
    memo.set(classKey, result);
    return result;
  };

  return {
    order: (classKey, ctx) => [...compute(classKey, ctx).order],
    boundaryOf: (classKey, ctx) => compute(classKey, ctx).closure,
    get linearizationFallbacks(): number {
      return fallbacks;
    },
  };
}

/**
 * The walker's separator for a base spelled as ALTERNATIVES (bd
 * tea-rags-mcp-4yh64). Written by `qualifyThroughStarImports` in
 * `../walker/walker.ts`; parsed here, the same way `::` is spelled there and
 * split in `strategies/shared.ts`. Legal in neither a Python identifier nor a
 * dotted module path, so it cannot collide with either half of a spelling.
 */
const BASE_ALTERNATIVE_SEPARATOR = "|";

/**
 * One base SPELLING → the class key it names, or the boundary flavour that
 * stopped it.
 *
 * {@link PYTHON_UNRESOLVABLE_BASE} is the walker's way of saying the base was
 * an expression it could not read — a computed
 * `Manager.from_queryset(QuerySet)` (bd tea-rags-mcp-invuy). It answers
 * `unknown` before the grammar below is consulted, for the same reason a
 * spent disjunction does: a branch nobody could read is not evidence the
 * member is absent, and it is not evidence the base is a library class either.
 *
 * A spelling carrying {@link BASE_ALTERNATIVE_SEPARATOR} is a DISJUNCTION: the
 * defining file star-imports, the name is bound by exactly one of the starred
 * modules, and the walker could not say which. The alternatives are tried in
 * the order the walker wrote them — the bare same-file spelling first, then one
 * per star module in declaration order — and the FIRST `project` verdict wins,
 * because only a module that actually declares the class can be the one that
 * bound the name.
 *
 * When no alternative names a project class the answer is `unknown`, never
 * `external`. The alternatives are candidates, not branches: "every candidate I
 * could check said library" is not the same evidence as "this base IS a library
 * class", and the difference decides whether `selfMember` DROPs a miss or falls
 * through. Keeping it `unknown` also makes the seam strictly additive — a bare
 * base that used to be `unknown` either pins now or stays exactly as it was.
 * The one exception is a BUILTIN bare name, which is decided before the split:
 * `class C(dict)` in a star-importing file is still a library base.
 */
function resolveBaseKey(
  spelling: string,
  definingFile: RelPath,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  mode: AmbiguousResolveMode,
): BaseKeyVerdict {
  // A base the walker could not read at all — a computed
  // `Manager.from_queryset(…)`. Decided before anything else: it names no
  // module and no class, so neither half of the grammar below applies to it.
  if (spelling === PYTHON_UNRESOLVABLE_BASE) return UNKNOWN_BASE;
  const alternatives = spelling.split(BASE_ALTERNATIVE_SEPARATOR);
  if (alternatives.length === 1) return resolveOneBaseSpelling(spelling, definingFile, ctx, mapper, mode);
  if (PYTHON_BUILTINS.has(alternatives[0])) return EXTERNAL_BASE;
  for (const alternative of alternatives) {
    const verdict = resolveOneBaseSpelling(alternative, definingFile, ctx, mapper, mode);
    if (verdict.kind === "project") return verdict;
  }
  return UNKNOWN_BASE;
}

/**
 * The two shapes the walker emits for ONE candidate: `<moduleText>::<ClassName>`
 * and a BARE name. A bare name is a same-file class or a builtin —
 * `qualifyPythonBase` only leaves a spelling unqualified when no import in the
 * DEFINING file bound its root. A module text goes through the import mapper,
 * whose three states map straight onto the boundary flavours: `external` is a
 * library base and a miss under it proves nothing, `unknown` is a hierarchy we
 * could not finish reading, and only `project` names a file the symbol table
 * can hold.
 *
 * The re-export hop is the same one `importedName` takes for a bound name: a
 * package `__init__.py` that re-exports `RepositoryBase` rather than declaring
 * it must not read as "the class is not there". A star-import alternative gets
 * it for free, which is what lets `from netbox.models import *` reach a mixin
 * the package only re-exports.
 */
function resolveOneBaseSpelling(
  spelling: string,
  definingFile: RelPath,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  mode: AmbiguousResolveMode,
): BaseKeyVerdict {
  const at = spelling.indexOf("::");
  if (at === -1) {
    // Bound by nothing in the defining file: its own class, or a builtin.
    if (PYTHON_BUILTINS.has(spelling)) return EXTERNAL_BASE;
    return classKeyIn(spelling, definingFile, ctx);
  }
  const moduleText = spelling.slice(0, at);
  const className = spelling.slice(at + 2);
  if (moduleText.length === 0 || className.length === 0) return UNKNOWN_BASE;
  const mapped = mapper.mapImportToFile(moduleText, definingFile, ctx);
  if (mapped.kind === "external") return EXTERNAL_BASE;
  if (mapped.kind !== "project") return UNKNOWN_BASE;
  const direct = classKeyIn(className, mapped.relPath, ctx);
  if (direct.kind === "project") return direct;
  const origin = reexportOriginFile(className, mapped.relPath, ctx, mode);
  return origin === null ? UNKNOWN_BASE : classKeyIn(className, origin, ctx);
}

/**
 * `className` as declared in `file`, addressed by its DOTTED FQ so a nested
 * `Outer.Inner` keeps its full spelling. Two declarations of one short name in
 * one file are `unknown`, not a coin flip.
 */
function classKeyIn(className: string, file: RelPath, ctx: CallContext): BaseKeyVerdict {
  const declared = lookupPythonSymbolsByShortName(ctx, className).filter((def) => def.relPath === file);
  if (declared.length !== 1) return UNKNOWN_BASE;
  const def = declared[0];
  return { kind: "project", classKey: pythonClassKey(def.relPath, pythonDeclaredClassFq(def)) };
}

/**
 * The ONE ancestor linearizer a Python run uses, rebuilt only when the run's
 * symbol table changes identity.
 *
 * `PythonCallResolver` composes its strategy chain in its CONSTRUCTOR, long
 * before any `CallContext` exists, but a linearizer is bound to a context — so
 * the chain is handed this cache instead of a linearizer, and asks it once per
 * call. The answer is the same object for the whole run, which is the property
 * decision 7 actually needs; keying on symbol-table identity is the same
 * mechanism `PythonImportFileMapper` uses for its own memo, so pass 2's grown
 * table gets a fresh linearizer rather than pass 1's truncated hierarchy.
 *
 * `undefined` when the run carries no `classAncestors` at all — an index
 * written by walker v2. A caller that gets it keeps its pre-seam behaviour
 * rather than answering from an empty map.
 */
export class PythonAncestorLinearizerCache {
  private current: AncestorLinearizer<CallContext> | undefined;
  private policy: PythonAncestorPolicy | undefined;

  constructor(
    private readonly mapper: PythonImportFileMapper,
    private readonly mode: AmbiguousResolveMode,
  ) {}

  for(ctx: CallContext): AncestorLinearizer<CallContext> | undefined {
    if (ctx.classAncestors === undefined) return undefined;
    if (this.current?.ctx.symbolTable !== ctx.symbolTable) {
      this.policy = createPythonAncestorPolicy(this.mapper, this.mode);
      this.current = createAncestorLinearizer(ctx, this.policy);
    }
    return this.current;
  }

  /** Fallback count of the linearizer currently held, for a gate to print. */
  get linearizationFallbacks(): number {
    return this.policy?.linearizationFallbacks ?? 0;
  }
}
