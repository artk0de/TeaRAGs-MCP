/**
 * Naming-convention receiver typing for Python (E2 seam 5, bd
 * tea-rags-mcp-9fgdi / 0g8g5) — `data_source.sync()` resolves to
 * `DataSource#sync`.
 *
 * The neutral gates live in `kernel/naming-convention.ts`; this file supplies
 * Python's three answers and the terminal.
 *
 *  - `camelize`: `snake_case` → `CamelCase`, and nothing else. A receiver
 *    already spelled `CamelCase` is a CONSTANT and belongs to `importedName`.
 *  - `classExists`: exactly one project declaration of that short name. Ruby
 *    accepts several because Zeitwerk makes the FQ recoverable; Python has no
 *    such guarantee, so two same-named classes in two packages are ambiguous
 *    and the convention declines.
 *  - `hasSubtypes`: any `classAncestors` VALUE whose bare last segment equals
 *    the candidate. The channel seam 4 built is the hierarchy evidence Python
 *    has; there is no `ctx.hierarchy` snapshot on this path.
 *
 * Gate 3, the terminal, is Ruby's and is restated verbatim in intent: the
 * member must PIN a symbol on the guessed class or its MRO. A class that
 * resolves but declares no such member emits NOTHING — no file-only edge. On
 * taxdome that gate is what made the Ruby tier shippable (372 wrong guesses
 * died silently at the terminal; edge accuracy 100 %), and it is the reason
 * this strategy can sit in the chain at all.
 *
 * Never DROPs. A DROP would claim the receiver's type is known-and-foreign,
 * which is exactly what a convention guess cannot establish.
 *
 * **Shipping condition, and how it was settled.** This is the one GUESS in the
 * plan: phantom up by more than +0.5 pp of edges on ANY corpus, or ugnest off
 * 0, and the strategy is REMOVED. The seam-5 closing A/B measured ten phantoms
 * — netbox 5, polar 3, ugnest 2 — all inside the bar (ugnest 2/772 = 0.26 pp)
 * but two of them on the anchor corpus, which is the clause with no slack in
 * it. Seven of the ten are one shape: a receiver assigned from a library call
 * (`user = authenticate(…)`, `get_object_or_404(…)`, `RQ_Job.fetch(…)`) whose
 * snake_case name camelizes onto a real project model. `boundToForeignCall`
 * below is the gate that answers them, and it costs nothing — ugnest back to
 * phantom 0 with all 24 of its gains intact. The remaining three are polar's
 * `_job_queue_manager`, a module global annotated `contextvars.ContextVar[...]`
 * whose annotation this path never reads; they are a different mechanism and
 * are left standing rather than tuned against.
 */
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { resolveLocalBindingType, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { conventionClassNameFor, type NamingConventionPorts } from "../../../kernel/naming-convention.js";
import { RunScopedMemo } from "../../../kernel/run-scoped-memo.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonExternalVocabulary } from "../python-external-vocabulary.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  lookupPythonSymbolsByShortName,
  pythonBoundClassKey,
  pythonBoundToForeignCall,
  resolvePythonInheritedMember,
  resolveTypeFile,
  type ResolverConfig,
} from "./shared.js";

export class PythonNamingConventionSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "namingConvention";

  /** Per run scope, `classAncestors` identity → the bare short name of every base anything declares. */
  private readonly descendantsOf = new RunScopedMemo<object, ReadonlySet<string>>();

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    private readonly linearizers?: PythonAncestorLinearizerCache,
    private readonly vocabulary: PythonExternalVocabulary = new PythonExternalVocabulary(mapper),
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const receiver = pythonConventionReceiverName(call.receiver);
    if (receiver === null) return CONTINUE;
    // A name the interpreter or a library owns is not a variable named after a
    // project class, whatever the project happens to declare under that
    // spelling. Same import question the rest of the chain asks, one memo.
    if (PYTHON_STDLIB_MODULES.has(receiver) || this.vocabulary.isBareCallExternal(receiver, ctx)) return CONTINUE;
    // A real fact wins: this pass speaks only for receivers nothing typed.
    if (resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) !== undefined) return CONTINUE;
    // And a FOREIGN right-hand side is a fact of the same kind. The walker saw
    // `user = authenticate(...)`, `localBinding` folded that callee and came
    // back with nothing; when the callee's own head is a name the project does
    // not declare, that silence says the receiver's type is decided somewhere
    // the project cannot read — not that it is undecided.
    if (pythonBoundToForeignCall(receiver, call.startLine, ctx)) return CONTINUE;

    const className = conventionClassNameFor(receiver, ctx, this.ports());
    if (className === undefined) return CONTINUE;
    const targetFile = resolveTypeFile(className, ctx, this.mapper);
    if (targetFile === null) return CONTINUE;
    const classKey = pythonBoundClassKey(className, targetFile, ctx);
    if (classKey === null) return CONTINUE;
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) return CONTINUE;
    const { target } = resolvePythonInheritedMember(classKey, call.member, ctx, this.cfg.mode, linearizer);
    // Gate 3: a class that owns nothing under this name emits NOTHING.
    if (target === null) return CONTINUE;
    return target.targetSymbolId === null ? CONTINUE : resolved(target);
  }

  /**
   * Python's port answers, bound to this strategy's descendant memo.
   *
   * `hasSubtypes` would otherwise scan a run-global record once per candidate —
   * netbox declares 6.6k classes and this pass is consulted on every site that
   * reached slot 7. The set is built ONCE per run scope and `classAncestors`
   * identity (bd tea-rags-mcp-39xca.6), so the next run — or a channel written
   * into in place — gets a fresh one, and a run pays for the scan a single time.
   */
  private ports(): NamingConventionPorts<CallContext> {
    return {
      camelize: pythonCamelize,
      classExists: (className, ctx) => lookupPythonSymbolsByShortName(ctx, className).length === 1,
      hasSubtypes: (className, ctx) => this.declaredBases(ctx).has(className),
    };
  }

  private declaredBases(ctx: CallContext): ReadonlySet<string> {
    const ancestors = ctx.classAncestors;
    if (ancestors === undefined) return EMPTY_BASES;
    const memo = this.descendantsOf.get(ctx.runScope, ancestors);
    if (memo !== undefined) return memo;
    const bases = new Set<string>();
    for (const spellings of Object.values(ancestors)) {
      for (const spelling of spellings) {
        const bare = spelling.split("::").pop()?.split(".").pop();
        if (bare !== undefined && bare.length > 0) bases.add(bare);
      }
    }
    this.descendantsOf.set(ctx.runScope, ancestors, bases);
    return bases;
  }
}

const EMPTY_BASES: ReadonlySet<string> = new Set<string>();

/** `data_source` → `DataSource`: upcase each `_`-separated segment, join. */
function pythonCamelize(snake: string): string {
  return snake
    .split("_")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/**
 * The receiver texts the convention acts on: a bare snake_case name, or the
 * HEAD of an index access (`prices[0]` → `prices` → `Price`, polar's 46 `index`
 * rows). Everything else — dotted chains, calls, `self`, CamelCase, dunders —
 * is another pass's.
 */
function pythonConventionReceiverName(receiver: string | null): string | null {
  if (receiver === null) return null;
  const head = /^([a-z_][a-z0-9_]*)(\[[^\]]*\])?$/.exec(receiver)?.[1] ?? null;
  if (head === null || head.startsWith("__") || head === "self" || head === "cls") return null;
  return head;
}
