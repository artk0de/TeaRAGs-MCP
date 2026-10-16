/**
 * ORM relation chains, the neutral half (bd tea-rags-mcp-2m83f.32.3).
 *
 * A query result is not an opaque collection: an ActiveRecord relation forwards
 * every member it does not define to its model's class, a Django `QuerySet`
 * exposes its model's custom queryset methods. So `Firm.without_deleted
 * .available_for(x)` calls a scope on `Firm`, and `dir.documents.ordered` a scope
 * on the association's model — never on a namesake elsewhere in the corpus.
 *
 * The language owns three answers, and they are the whole precision story:
 *
 *  1. the framework vocabulary is ACTIVE — the project declares the ORM. Without
 *     it a container is a plain collection and forwards nothing.
 *  2. the receiver type READS as a relation over a project model. Typing the
 *     hops (query methods keep the relation, scopes return it, associations
 *     yield it) is the receiver-typing port's job, shared with `chainType`.
 *  3. the model's class side DECLARES the member — the model, its mixins, the
 *     framework base, in the language's own lookup order. A miss is silence:
 *     the strategy never guesses, because a wrong edge costs more than none.
 *
 * Gates are ordered and short-circuit: an inactive vocabulary never types the
 * receiver, a non-relation never walks the model.
 */
import { CONTINUE, DROP, resolved } from "../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy, TypeRef } from "../../../contracts/types/language.js";
import { hasReceiver, type ReceiverTypingPorts } from "./receiver-typed-strategies.js";

/** The per-language answers the relation-chain verdict is composed from. */
export interface OrmRelationPorts {
  /** Does the project declare the ORM whose relations forward to their model? */
  vocabularyActive: (ctx: CallContext) => boolean;
  /** The model a receiver type ranges over as a relation, or `undefined` for any other type. */
  relationModelOf: (type: TypeRef, ctx: CallContext) => string | undefined;
  /** The class-side member the relation forwards to: model, then its mixins, then the framework base. */
  memberOnModel: (model: string, member: string, ctx: CallContext) => SymbolResolutionTarget | null;
}

/** How a relation receiver whose model declares no pinned member ends. */
interface OrmRelationChainOptions {
  /**
   * DROP instead of CONTINUE — for a language whose earlier typed pass spared
   * the relation from its own typed-miss DROP, so no later guard holds the call
   * back from the short-name passes.
   */
  readonly dropOnMiss?: boolean;
}

/**
 * Three-state verdict: `resolved` only on a member PINNED on the model's class
 * side; `CONTINUE` otherwise, so the language's later guards keep the call —
 * or `DROP` on a relation miss under {@link OrmRelationChainOptions.dropOnMiss}.
 */
export class OrmRelationChainSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly typing: ReceiverTypingPorts,
    private readonly ports: OrmRelationPorts,
    private readonly options: OrmRelationChainOptions = {},
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!hasReceiver(call) || !this.ports.vocabularyActive(ctx)) return CONTINUE;
    const type = this.typing.typeOfReceiver(call, ctx);
    if (type === null) return CONTINUE;
    const model = this.ports.relationModelOf(type, ctx);
    if (model === undefined) return CONTINUE;
    const target = this.ports.memberOnModel(model, call.member, ctx);
    if (target?.targetSymbolId) return resolved(target);
    return this.options.dropOnMiss === true ? DROP : CONTINUE;
  }
}

/**
 * A relation fact declared on a MIXIN ranges over whoever includes it — the
 * relation counterpart of `-> Self`. A Rails concern's `included do` scope is
 * stated over the concern (`SoftDeletable.without_deleted` → relation of
 * `SoftDeletable`), but `Firm.without_deleted` is a relation of `Firm`. Any
 * other answer, and the mixin asked about itself, is returned as is.
 */
export function substituteRelationSelf(
  type: TypeRef,
  receiverModel: string,
  isMixin: (name: string) => boolean,
): TypeRef {
  if (type.form !== "container") return type;
  const { element } = type;
  if (element.form !== "instance" || element.name === receiverModel || !isMixin(element.name)) return type;
  return { form: "container", element: { form: "instance", name: receiverModel } };
}
