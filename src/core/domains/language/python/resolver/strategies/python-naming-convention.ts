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
import {
  resolveLocalBindingType,
  type AmbiguousResolveMode,
  type CallContext,
} from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  conventionClassNameFor,
  ConventionReceiverSymbolResolutionStrategy,
  createTypeMemberLookup,
  RunScopedMemo,
  type ConventionReceiverTypingPorts,
  type NamingConventionPorts,
  type ReceiverCallRef,
  type TypeMemberLookup,
} from "../../../kernel/index.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonExternalVocabulary } from "../python-external-vocabulary.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  lookupPythonSymbolsByShortName,
  pythonBoundClassKey,
  pythonBoundToForeignCall,
  pythonModuleValueClass,
  resolvePythonInheritedMember,
  resolveTypeFile,
  type ResolverConfig,
} from "./shared.js";

/**
 * The verdict is the kernel's `ConventionReceiverSymbolResolutionStrategy` (bd
 * tea-rags-mcp-m99j1.1.5): it never DROPs and refuses a file-only target (gate
 * 3). This class binds {@link PythonConventionReceiverTyping} as the typing port
 * and {@link createPythonConventionMemberLookup} as the member walk.
 */
export class PythonNamingConventionSymbolResolutionStrategy extends ConventionReceiverSymbolResolutionStrategy {
  constructor(
    cfg: ResolverConfig,
    mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    linearizers?: PythonAncestorLinearizerCache,
    vocabulary: PythonExternalVocabulary = new PythonExternalVocabulary(mapper),
  ) {
    super(
      "namingConvention",
      new PythonConventionReceiverTyping(vocabulary, mapper),
      createPythonConventionMemberLookup(cfg.mode, mapper, linearizers),
    );
  }
}

/**
 * Python's convention guess and the fact channels it yields to. The kernel asks
 * the guess first and the facts second; both are pure, so the order — the
 * reverse of the pre-kernel pass — moves cost only, never an answer.
 */
class PythonConventionReceiverTyping implements ConventionReceiverTypingPorts {
  /** Per run scope, `classAncestors` identity → the bare short name of every base anything declares. */
  private readonly descendantsOf = new RunScopedMemo<object, ReadonlySet<string>>();

  /**
   * Python's port answers, bound to this port's descendant memo.
   *
   * `hasSubtypes` would otherwise scan a run-global record once per candidate —
   * netbox declares 6.6k classes and this pass is consulted on every site that
   * reached slot 7. The set is built ONCE per run scope and `classAncestors`
   * identity (bd tea-rags-mcp-39xca.6), so the next run — or a channel written
   * into in place — gets a fresh one, and a run pays for the scan a single time.
   */
  private readonly conventionPorts: NamingConventionPorts<CallContext> = {
    camelize: pythonCamelize,
    classExists: (className, ctx) => lookupPythonSymbolsByShortName(ctx, className).length === 1,
    hasSubtypes: (className, ctx) => this.declaredBases(ctx).has(className),
  };

  constructor(
    private readonly vocabulary: PythonExternalVocabulary,
    private readonly mapper: PythonImportFileMapper,
  ) {}

  typeOfReceiver(call: ReceiverCallRef, ctx: CallContext): TypeRef | null {
    const receiver = pythonConventionReceiverName(call.receiver);
    if (receiver === null) return null;
    const className = conventionClassNameFor(receiver, ctx, this.conventionPorts);
    return className === undefined ? null : { form: "instance", name: className };
  }

  isTypedElsewhere(call: ReceiverCallRef, ctx: CallContext): boolean {
    const receiver = pythonConventionReceiverName(call.receiver);
    if (receiver === null) return true;
    // A name the interpreter or a library owns is not a variable named after a
    // project class, whatever the project happens to declare under that
    // spelling. Same import question the rest of the chain asks, one memo.
    if (PYTHON_STDLIB_MODULES.has(receiver) || this.vocabulary.isBareCallExternal(receiver, ctx)) return true;
    // A real fact wins: this pass speaks only for receivers nothing typed.
    if (resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) !== undefined) return true;
    // A module-scope value the walker typed (P4, bd m99j1.1.15) is a fact too:
    // `apps` after `from django.apps import apps` is an `Apps`, not a guess.
    if (pythonModuleValueClass(receiver, ctx, this.mapper) !== null) return true;
    // And a FOREIGN right-hand side is a fact of the same kind. The walker saw
    // `user = authenticate(...)`, `localBinding` folded that callee and came
    // back with nothing; when the callee's own head is a name the project does
    // not declare, that silence says the receiver's type is decided somewhere
    // the project cannot read — not that it is undecided.
    return pythonBoundToForeignCall(receiver, call.startLine, ctx);
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

/**
 * The member walk on the guessed class: the class must be the ONE the run
 * binds under that name, and the member is read on it and up its C3 MRO. A run
 * with no ancestor linearizer (walker v2 index) keeps the pre-seam silence — no
 * walk, no answer. Gate 3 (the target must pin a symbol) is the kernel's.
 */
function createPythonConventionMemberLookup(
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeMemberLookup {
  return createTypeMemberLookup((type, member, ctx) => {
    const targetFile = resolveTypeFile(type.name, ctx, mapper);
    if (targetFile === null) return null;
    const classKey = pythonBoundClassKey(type.name, targetFile, ctx);
    if (classKey === null) return null;
    const linearizer = linearizers?.for(ctx);
    if (linearizer === undefined) return null;
    return resolvePythonInheritedMember(classKey, member, ctx, mode, linearizer).target;
  });
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
