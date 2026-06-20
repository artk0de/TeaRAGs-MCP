import type { CallContext, CallRef, DispatchEdge } from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { ConeDispatchResolver } from "../../../cone-dispatch.js";
import { RubyConeTypeLocator } from "./ruby-cone-type-locator.js";
import { CONE_MAX_DEFAULT, type ResolverConfig } from "./shared.js";

/**
 * Ruby binding of the generic CHA cone-dispatch engine (bd tea-rags-mcp-2jet
 * variant A, generalized in f10y). A thin wrapper: it composes the
 * language-neutral `ConeDispatchResolver` with the Ruby-specific
 * `RubyConeTypeLocator` (Zeitwerk constant resolution + scope-tail / `::`
 * override match) and the Ruby cone cap (`cfg.coneMax`, env
 * `CODEGRAPH_RB_CONE_MAX`, default 8). The whole CHA algorithm —
 * descendants ∩ override, K-threshold, cone / poly-base fan-out, confidence —
 * lives in the engine; this class adds nothing but the Ruby wiring.
 *
 * Public constructor signature + behavior are preserved verbatim so the
 * provider wiring and the existing cone tests are unaffected.
 */
export class RubyConeDispatchResolver implements DispatchResolverComponent {
  private readonly engine: ConeDispatchResolver;

  constructor(cfg: ResolverConfig) {
    this.engine = new ConeDispatchResolver(new RubyConeTypeLocator(cfg), cfg.coneMax ?? CONE_MAX_DEFAULT);
  }

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    return this.engine.resolveDispatch(call, ctx);
  }
}
