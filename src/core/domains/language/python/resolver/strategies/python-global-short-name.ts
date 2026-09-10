import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import { lookupPythonSymbolsByShortName, type ResolverConfig } from "./shared.js";

/**
 * A declaration at MODULE scope — the only kind a bare name may reach in the
 * caller's own file (bd tea-rags-mcp-c9tw2).
 *
 * `scope` is the chunker's enclosing-container path, and Python's kernel sets
 * `scopeContainerTypes: ["class_definition"]`, so an empty scope means "no
 * enclosing class": a top-level `def` / `class`, which is exactly the module
 * binding Python's LEGB walk finds. A method carries its class (`["Cls"]`), a
 * nested class its outer (`["Outer"]`), and neither is reachable by a bare
 * name from module scope. Lives here rather than in `shared.ts` — one caller.
 */
const isModuleLevel = (def: SymbolDefinition): boolean => def.scope.length === 0;

/**
 * Is `defScope` a container the caller is written INSIDE (bd tea-rags-mcp-w205u)?
 *
 * The `E` of Python's LEGB walk. `def outer(): def inner(): ...; inner()` binds
 * `inner` in `outer`'s frame, so a bare `inner()` anywhere inside `outer`
 * reaches it even though `inner` is not module-level.
 *
 * ONE segment of slack, because `callerScope` omits the caller's OWN container
 * by convention (`CallContext.callerScope`): a call in `get_catalog_plugins`'
 * body carries `[]`, while the nested `get_catalog_plugins#make_plugin_dict`
 * carries `["get_catalog_plugins"]`. Without the slack the arm recovers 9 of
 * the 82 rows the module-level-only guard cost; with it, all 82.
 *
 * Measured: those 82 rows (flask 2, netbox 18, polar 62) are every same-file
 * nested `def` plus polar's classes declared inside a `def`
 * (`Authenticator._AuthenticatorSignature`). The slack does admit a class-body
 * member of the caller's own class, which the LEGB walk does not reach — a
 * known over-admission, bounded by the file check and by the builtins guard
 * above it, and carrying no measured cost: across all five corpora ZERO
 * `globalShortName` bare-call phantom names a target in the caller's own file.
 */
const isEnclosingScope = (defScope: readonly string[], callerScope: readonly string[]): boolean =>
  defScope.length <= callerScope.length + 1 &&
  defScope.slice(0, callerScope.length).every((segment, i) => segment === callerScope[i]);

/**
 * Can a BARE name written at this call site reach this definition at all?
 *
 * Two arms, and the file boundary is what separates them. ACROSS files only a
 * module-level `def` / `class` is reachable — an import binds a module's
 * top-level names and nothing deeper, which is why `open(...)` in
 * `src/flask/cli.py` cannot name `src/flask/testing.py#FlaskClient#open`.
 * WITHIN the caller's own file the enclosing-function chain is reachable too.
 */
const isBareCallable = (def: SymbolDefinition, ctx: CallContext): boolean =>
  isModuleLevel(def) || (def.relPath === ctx.callerFile && isEnclosingScope(def.scope, ctx.callerScope));

/**
 * Global short-name fallback — the LAST strategy in the chain, and now a guess
 * that is only allowed to speak about calls whose enclosing scope really owns
 * the member (bd tea-rags-mcp-99t5y).
 *
 * A member name is evidence about what is CALLED. It says nothing about what it
 * is called ON, so on a receiver-bound call `lookupByShortName(member)` answers
 * with whatever unrelated project class happens to spell that member — a
 * fabricated edge, not a weak one. The seeded oracle separates the two families
 * cleanly (match / phantom, per receiverKind):
 *
 *   - in credit — `bareCall` netbox 441/0, polar 3259/80, ugnest 129/0;
 *     `selfMember` netbox 756/40, polar 1284/3. The call names a function the
 *     module or the enclosing class owns, and the short name IS the evidence.
 *   - in deficit — `chain` ugnest 0/124, polar 69/567, netbox 142/175;
 *     `dynamic` ugnest 1/17, polar 357/547, netbox 42/89; plus `index`,
 *     `localVar` and `constant`, each losing on every corpus that has them.
 *
 * So the receiver decides. `bareCall` and `selfMember` reach the table;
 * everything else CONTINUEs — never DROP, because the typed passes above have
 * already had their say and refusing on their behalf would suppress work they
 * park. As the last strategy, a CONTINUE here exhausts to `null`, which is the
 * original terminal `return null`.
 *
 * The gate reads `call.receiver` directly rather than importing the trajectory's
 * `classifyReceiverKind`: `language` is a leaf domain and may not import a
 * sibling (`.claude/rules/domain-boundaries.md`). Nothing is re-implemented —
 * the two kinds admitted here are the classifier's two UNCONDITIONAL ones,
 * `receiver === null` for `bareCall` and `receiver === "self"` for
 * `selfMember`, neither of which consults localBindings or any pattern. Every
 * kind the classifier decides by inspecting receiver TEXT is on the other side
 * of the gate, so the two cannot drift apart.
 *
 * `constant` left the guess list rather than the chain: `Cls.method()` on a
 * class the calling file declares is now resolved from the symbol table by
 * `importedName`'s same-file class arm, on the receiver's own evidence.
 *
 * The `bareCall` arm carries three further guards, all of them stating what a
 * bare name in Python CAN reach (bd tea-rags-mcp-w205u):
 *
 *   - same LANGUAGE — {@link lookupPythonSymbolsByShortName} rather than the
 *     raw table, because the table spans every indexed extension. polar's
 *     `range(...)` was landing on `Paginator.tsx#range`.
 *   - a BUILTIN the caller's file does not shadow is the interpreter's, so the
 *     arm claims it as external instead of picking a namesake.
 *   - BARE-CALLABLE candidates only — see {@link isBareCallable}. A bare name
 *     reaches local → enclosing → module → builtins, so `open(...)` in another
 *     file cannot name `FlaskClient#open` and `field_class()` cannot name
 *     `JSONSchemaProperty#field_class`.
 *
 * The `self` arm keeps the full candidate set: `self.open()` IS attribute
 * lookup down the MRO, which is where those methods live.
 */
export class PythonGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null && call.receiver !== "self") return CONTINUE;
    const fallback = lookupPythonSymbolsByShortName(ctx, call.member);
    // ── Module scope wins, because Python says so (bd tea-rags-mcp-c9tw2) ──
    // A BARE call names the module's own binding before it names anything a
    // sibling package happens to spell the same way: the interpreter resolves
    // local → enclosing → MODULE → builtins and never consults another file.
    // So a module-level `def` / `class` in the CALLER's file is not a guess —
    // it is the answer, and it must win over the cardinality guard below,
    // which otherwise throws the whole site away. Measured on the seeded
    // oracle, this ONE mechanism is the entire `bareCall` hole: polar 416/420,
    // netbox 24/24, ugnest 12/12, httpx 7/7, flask 5/5, every row carrying
    // `oracleTargetRelPath == relPath`; 372 of polar's and 18 of netbox's name
    // a top-level symbol.
    //
    // Two restrictions carry the precision guarantee:
    //   - `receiver === null` only. `self.x()` is ATTRIBUTE lookup down the
    //     MRO, a different resolution order entirely, so the `self` arm keeps
    //     the pre-task fallback untouched.
    //   - MODULE-LEVEL targets only. A same-file `Cls#helper` is callable bare
    //     only from inside `Cls`, and that is enclosing-scope evidence this
    //     strategy does not read; those fall through unchanged.
    if (call.receiver === null) {
      const sameFileModuleLevel = fallback.filter((def) => def.relPath === ctx.callerFile && isModuleLevel(def));
      const own = pickSingleCandidate(sameFileModuleLevel, "strict");
      if (own) return resolved({ targetRelPath: own.relPath, targetSymbolId: own.symbolId });
      // ── Past the caller's own module, a bare name reaches builtins ─────────
      // The LEGB walk ends at the interpreter, so a bare `open` / `type` /
      // `range` the caller's file does not shadow IS the builtin, and any
      // cross-file candidate spelling it is a fabricated edge by construction.
      // DROP rather than CONTINUE: this is the last strategy, so the two agree
      // on the emitted edge, but a DROP records that the call was CLAIMED as
      // external instead of leaving it in the unresolved bucket. `importedName`
      // sits one slot earlier and answers first when an import bound the name,
      // so a project symbol that legitimately shadows a builtin never reaches
      // this line (`python-chain-factory.ts` slots 7 and 8).
      if (PYTHON_BUILTINS.has(call.member)) return DROP;
      // A bare name reaches MODULE scope, never a class body or another
      // function's locals: `open(...)` cannot name `FlaskClient#open`, which is
      // 9 of flask's 11 phantoms, and `field_class()` cannot name
      // `JSONSchemaProperty#field_class`.
      //
      // The pick runs over the WHOLE candidate set and the verdict is REJECTED
      // when it lands off module scope — the filter is not applied before the
      // pick. Filtering first would let an unreachable candidate stop counting
      // toward ambiguity and turn a site the cardinality guard used to throw
      // away into a NEW cross-file edge, which is recall this task did not
      // measure and cannot vouch for. Precision-only: every site this changes
      // loses an edge, none gains one.
      const reachable = pickSingleCandidate(fallback, this.cfg.mode);
      return reachable && isBareCallable(reachable, ctx)
        ? resolved({ targetRelPath: reachable.relPath, targetSymbolId: reachable.symbolId })
        : CONTINUE;
    }
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
