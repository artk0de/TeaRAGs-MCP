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
 * **Shipping condition.** This is the one GUESS in the plan. If the row-level
 * A/B shows phantom up by more than +0.5 pp of edges on ANY corpus, or ugnest
 * moving off 0, the strategy is REMOVED — not tuned, not gated further. That
 * decision was taken before it was written.
 */
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { resolveLocalBindingType, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { conventionClassNameFor, type NamingConventionPorts } from "../../../kernel/naming-convention.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonExternalVocabulary } from "../python-external-vocabulary.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { pythonBoundClassKey, resolvePythonInheritedMember, resolveTypeFile, type ResolverConfig } from "./shared.js";

export class PythonNamingConventionSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "namingConvention";

  /** `classAncestors` identity → the bare short name of every base anything declares. */
  private readonly descendantsOf = new WeakMap<object, ReadonlySet<string>>();

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
   * reached slot 7. The set is built ONCE per `classAncestors` identity and
   * keyed by the record itself, so a run that rebuilds the channel gets a fresh
   * one and a run that does not pays for the scan a single time.
   */
  private ports(): NamingConventionPorts<CallContext> {
    return {
      camelize: pythonCamelize,
      classExists: (className, ctx) => ctx.symbolTable.lookupByShortName(className).length === 1,
      hasSubtypes: (className, ctx) => this.declaredBases(ctx).has(className),
    };
  }

  private declaredBases(ctx: CallContext): ReadonlySet<string> {
    const ancestors = ctx.classAncestors;
    if (ancestors === undefined) return EMPTY_BASES;
    const memo = this.descendantsOf.get(ancestors);
    if (memo !== undefined) return memo;
    const bases = new Set<string>();
    for (const spellings of Object.values(ancestors)) {
      for (const spelling of spellings) {
        const bare = spelling.split("::").pop()?.split(".").pop();
        if (bare !== undefined && bare.length > 0) bases.add(bare);
      }
    }
    this.descendantsOf.set(ancestors, bases);
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
