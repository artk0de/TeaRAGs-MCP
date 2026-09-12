/**
 * Python implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/python/python-resolver.ts`
 * into the native Python language provider per the `domains/language`
 * consolidation (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the four-state outcome
 * (resolved / deferred / drop / continue) makes the load-bearing guard drops explicit —
 * a `self.<field>` / `self` / `super()` / locally-bound receiver that fails to
 * resolve DROPS rather than falling through to the ambiguous global short-name
 * path (which is exactly the source of the ugnest false positive,
 * `serializer.is_valid()` attributed to `ConfirmationCode`).
 *
 * The chain itself is composed by `createPythonSymbolResolutionChain`
 * (`./python-chain-factory.js`), which the offline harnesses call too so their
 * rebuilt chain cannot drift from this one (bd tea-rags-mcp-3yxmy).
 *
 * The pass order (each `name` in parens):
 *   1. super (super().X via classExtends — terminal guard)
 *   2. selfField (self.<field>.X via classFieldTypes — terminal guard)
 *   3. selfMember (self.X via enclosing class + classExtends walk — terminal guard)
 *   4. localBinding (var.X via walker-bound type — terminal guard)
 *   5. chainType (dotted receiver folded to a type through the shared kernel
 *      engine — `x = svc.build(); x.run()`, `self.repo.get(id).save()`;
 *      terminal guard — bd tea-rags-mcp-9fgdi)
 *   6. importedName (receiver / bare callee is an imported binding; one
 *      re-export hop; star imports — bd tea-rags-mcp-9fgdi)
 *   7. globalShortName (global short-name fallback)
 *
 * Python's import style (`from foo import bar`) binds Y as a local name while X
 * names the module file, so `importedName` reads the walker's binding table
 * rather than inferring the bound name from the module path. The pass that DID
 * infer it, `importMatch`, was removed once the oracle measured its residual
 * (bd tea-rags-mcp-rw1qk).
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type DispatchFanoutOutcome,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent, SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { ConeDispatchResolver } from "../../cone-dispatch.js";
import { ExternalCallClassifier } from "../../external-classifier.js";
import { resolveImportFileEdges } from "../../import-file-edges.js";
import { resolveDispatchViaComponents } from "../../resolver-chain.js";
import {
  PythonChainAnswerProbe,
  pythonDynamicDispatchEnabled,
  PythonDynamicDispatchResolver,
} from "./dispatch/index.js";
import { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { createPythonSymbolResolutionChain } from "./python-chain-factory.js";
import { PythonExternalVocabulary } from "./python-external-vocabulary.js";
import { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { CONE_MAX_DEFAULT, PythonConeTypeLocator, type ResolverConfig } from "./strategies/index.js";

/** Parse `CODEGRAPH_PY_CONE_MAX`; fall back to the Python default on absent/invalid. */
function resolveConeMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CONE_MAX_DEFAULT;
}

export class PythonCallResolver implements CallResolver {
  readonly language = "python";
  private readonly chain: SymbolResolutionStrategy[];
  private readonly cone: ConeDispatchResolver;
  private readonly external: ExternalCallClassifier;
  /**
   * The chain's answer per call site, computed once (bd tea-rags-mcp-w205u).
   * `resolve` reads it, and so does the last dispatch component's final gate,
   * so the runner's `resolveDispatch` → `resolve` pair runs the chain ONCE.
   */
  private readonly probe: PythonChainAnswerProbe;
  /**
   * Dispatch components in PRECEDENCE order, first non-empty wins
   * (`resolveDispatchViaComponents`). The CHA cone leads because a receiver
   * whose static type is known is not a guess; `dynamic` would be last because
   * it answers only what nothing else — the cone, and the exact chain behind its
   * own probe gate — can.
   *
   * `dynamic` is composed ONLY under `CODEGRAPH_PY_DYNAMIC_DISPATCH` and is off
   * by default (D10): its `single` terminal is a name-only claim, and measured
   * over five corpora it is right about as often as it is wrong. With the flag
   * absent this array is the cone alone, byte-identically to the pre-E4.1.3
   * behaviour.
   */
  private readonly dispatchComponents: readonly DispatchResolverComponent[];
  /**
   * ONE mapper for the whole resolver: its memo is per-symbol-table identity,
   * so every consumer sharing the instance shares the resolved-root cache.
   * Every Python consumer of "which file is this import" reads it — the chain
   * (`localBinding`, `importedName`), the cone locator through
   * `resolveTypeFile`, the external vocabulary, and `resolveFileEdges`.
   */
  private readonly importFileMapper = new PythonImportFileMapper();
  /**
   * ONE ancestor linearizer for the whole run, for the same reason the mapper is
   * one: its MRO memo is keyed by symbol-table identity. netbox has ~3,600
   * classes against ~30,000 `self.` call sites, so a per-call-site walk is the
   * difference between a memo hit and re-linearizing the hierarchy 30,000 times
   * (bd tea-rags-mcp-9fgdi, decision 7). The chain is composed here, before any
   * `CallContext` exists, so the CACHE is what the strategies hold; it answers
   * with the run's linearizer on first use.
   */
  private readonly ancestorLinearizers: PythonAncestorLinearizerCache;

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode, coneMax: resolveConeMax(process.env.CODEGRAPH_PY_CONE_MAX) };
    this.ancestorLinearizers = new PythonAncestorLinearizerCache(this.importFileMapper, mode);
    this.chain = createPythonSymbolResolutionChain(cfg, this.importFileMapper, this.ancestorLinearizers);
    this.cone = new ConeDispatchResolver(
      new PythonConeTypeLocator(cfg, this.importFileMapper),
      cfg.coneMax ?? CONE_MAX_DEFAULT,
    );
    // The classifier is built BEFORE the component that closes over it. The
    // vocabulary gets the run's ONE linearizer cache (bd tea-rags-mcp-1v12o.3):
    // its definition probe asks MRO questions, and a private cache would both
    // re-linearize the hierarchy and be free to disagree with the chain's.
    this.external = new ExternalCallClassifier(
      new PythonExternalVocabulary(this.importFileMapper, this.ancestorLinearizers, mode),
    );
    this.probe = new PythonChainAnswerProbe(this.chain);
    this.dispatchComponents = pythonDynamicDispatchEnabled(process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH)
      ? [
          this.cone,
          new PythonDynamicDispatchResolver(this.probe, (call, ctx) =>
            this.external.targetsCoreAmbiguousMember(call, ctx),
          ),
        ]
      : [this.cone];
  }

  /**
   * Read-only view of the composed chain, so an offline harness can PROVE it
   * mirrors production instead of asserting a copy of the order.
   */
  get strategies(): readonly SymbolResolutionStrategy[] {
    return this.chain;
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return this.probe.resolve(call, ctx);
  }

  /**
   * Dispatch fan-out for a Python call, over the components in
   * {@link dispatchComponents} — first non-empty (or `ambiguous`) wins.
   *
   *  - `cone` — CHA (bd tea-rags-mcp-f10y, N=2). A polymorphic TYPED receiver
   *    (`pet: Animal`, then `pet.speak()`) whose static type has subtypes
   *    overriding the member fans to N `cone` edges, or one `poly-base` edge
   *    above the cone cap. An unbound or external receiver carries no
   *    `localBinding`, so `T` is undefined and the cone says nothing.
   *  - `dynamic` — the untyped bare-name fan (bd tea-rags-mcp-w205u, E4.1.3),
   *    capped at `PY_DISPATCH_FAN_MAX`, composed only under
   *    `CODEGRAPH_PY_DYNAMIC_DISPATCH` (default OFF, D10). It declines every
   *    receiver another layer owns, the chain probe included, so the exact
   *    chain stays the default for everything it can answer.
   *
   * The runner consults this BEFORE `resolve` and a non-empty fan REPLACES the
   * chain's answer, which is why declining is the components' first job.
   */
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return resolveDispatchViaComponents(this.dispatchComponents, call, ctx);
  }

  /**
   * File→file edges from imports, through the mapper rather than through a
   * synthesised call (bd tea-rags-mcp-9fgdi).
   *
   * `defaultImportFileEdges` pushed a fake `{receiver, member} = lastSegment`
   * call through the whole chain and committed whatever came back — which, for
   * Python, was the since-removed `importMatch` pass's file-only edge on a path
   * `mapPythonImportToFile` invented. Answering the import question directly
   * removes the phantom AND the coupling: a change to call-resolution
   * precedence no longer silently rewrites the file graph.
   *
   * The counts MOVE when this lands. That is the intent — a package import that
   * pointed at `dcim/models.py` now points at `dcim/models/__init__.py`, and a
   * stdlib import that had an edge now has none. The jedi oracle is the gate,
   * not edge-count parity.
   */
  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    return resolveImportFileEdges(extraction, this.importFileMapper, ctx);
  }

  /**
   * tea-rags-mcp-ykj7, relocated to the shared engine by mmckn. The decision
   * now lives in `PythonExternalVocabulary`; the shape branch (bare vs
   * qualified) is the engine's. Behaviour is preserved for every case
   * `python-resolver-external-import.test.ts` pins, and extended in two
   * directions only: a bare call to a BUILTIN is now external, and a
   * first-party ABSOLUTE import is no longer called external.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    return this.external.targetsExternal(call, ctx);
  }

  /**
   * tea-rags-mcp-83cl7 for Python. A core-named member on an UNTYPED receiver
   * (`row.get(key)`) whose real callee is the dict / list / str runtime, not the
   * project class that happens to define the same short name. Consulted only
   * for calls the chain declined and that the external arm did not claim.
   */
  targetsCoreAmbiguousMember(call: CallRef, ctx: CallContext): boolean {
    return this.external.targetsCoreAmbiguousMember(call, ctx);
  }
}
