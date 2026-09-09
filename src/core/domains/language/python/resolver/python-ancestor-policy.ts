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
import { linearizeC3 } from "./mro.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { parsePythonClassKey, pythonClassKey } from "./strategies/shared.js";

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
      if (parsed === null || spellings === undefined) return [];
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
 * One base SPELLING → the class key it names, or the boundary flavour that
 * stopped it.
 *
 * The two shapes the walker emits are `<moduleText>::<ClassName>` and a BARE
 * name. A bare name is a same-file class or a builtin — `qualifyPythonBase`
 * only leaves a spelling unqualified when no import in the DEFINING file bound
 * its root. A module text goes through the import mapper, whose three states
 * map straight onto the boundary flavours: `external` is a library base and a
 * miss under it proves nothing, `unknown` is a hierarchy we could not finish
 * reading, and only `project` names a file the symbol table can hold.
 *
 * The re-export hop is the same one `importedName` takes for a bound name: a
 * package `__init__.py` that re-exports `RepositoryBase` rather than declaring
 * it must not read as "the class is not there".
 */
function resolveBaseKey(
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
  const declared = ctx.symbolTable.lookupByShortName(className).filter((def) => def.relPath === file);
  if (declared.length !== 1) return UNKNOWN_BASE;
  const def = declared[0];
  return { kind: "project", classKey: pythonClassKey(def.relPath, [...def.scope, def.shortName].join(".")) };
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
