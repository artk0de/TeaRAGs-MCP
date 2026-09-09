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
 *   7. importMatch (receiver matches an import's trailing segment)
 *   8. globalShortName (global short-name fallback)
 *
 * Python's syntax differs from TS in import style (`from foo import bar`), so
 * the "receiver matches an import" check also considers names imported via
 * `from X import Y` — Y becomes a locally-bound name even though X is the module
 * file. This is pragmatically handled by accepting the final segment of the
 * import path as the receiver match.
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
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { ConeDispatchResolver } from "../../cone-dispatch.js";
import { ExternalCallClassifier } from "../../external-classifier.js";
import { resolveImportFileEdges } from "../../import-file-edges.js";
import { resolveViaChain } from "../../resolver-chain.js";
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
   * ONE mapper for the whole resolver: its memo is per-symbol-table identity,
   * so every consumer sharing the instance shares the resolved-root cache.
   * Every Python consumer of "which file is this import" reads it — the chain
   * (`localBinding`, `importedName`, `importMatch`), the cone locator through
   * `resolveTypeFile`, the external vocabulary, and `resolveFileEdges`.
   */
  private readonly importFileMapper = new PythonImportFileMapper();

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode, coneMax: resolveConeMax(process.env.CODEGRAPH_PY_CONE_MAX) };
    this.chain = createPythonSymbolResolutionChain(cfg, this.importFileMapper);
    this.cone = new ConeDispatchResolver(
      new PythonConeTypeLocator(cfg, this.importFileMapper),
      cfg.coneMax ?? CONE_MAX_DEFAULT,
    );
    this.external = new ExternalCallClassifier(new PythonExternalVocabulary(this.importFileMapper));
  }

  /**
   * Read-only view of the composed chain, so an offline harness can PROVE it
   * mirrors production instead of asserting a copy of the order.
   */
  get strategies(): readonly SymbolResolutionStrategy[] {
    return this.chain;
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.chain, call, ctx);
  }

  /**
   * CHA cone fan-out for a Python call (bd tea-rags-mcp-f10y, N=2). A
   * polymorphic TYPED receiver (`pet: Animal`, then `pet.speak()`) whose static
   * type has subtypes overriding the member fans out to N `cone` edges (or one
   * `poly-base` edge above the cone cap). Returns `[]` for every non-polymorphic
   * call — an `external` / unbound receiver carries no `localBinding`, so `T` is
   * undefined and the cone returns `[]` (external never cones); the provider then
   * takes the exact `resolve` chain.
   */
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return this.cone.resolveDispatch(call, ctx);
  }

  /**
   * File→file edges from imports, through the mapper rather than through a
   * synthesised call (bd tea-rags-mcp-9fgdi).
   *
   * `defaultImportFileEdges` pushed a fake `{receiver, member} = lastSegment`
   * call through the whole chain and committed whatever came back — which, for
   * Python, was `importMatch`'s file-only edge on a path
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
