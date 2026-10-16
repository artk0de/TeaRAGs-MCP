import { OrmRelationChainSymbolResolutionStrategy, type OrmRelationPorts } from "../../../kernel/index.js";
import { railsVocabularyActive } from "./rails-vocabulary-gate.js";
import { activeRecordRelationModel } from "./ruby-active-record-return-types.js";
import { resolveTypeStaticMethod, type ResolverConfig } from "./shared.js";
import { typeOfConventionRootedReceiver, typeOfReceiver } from "./type-propagation.js";

export { railsVocabularyActive } from "./rails-vocabulary-gate.js";

/**
 * The Rails port of the kernel's ORM relation chain (bd tea-rags-mcp-2m83f.32.3):
 * a relation of an AR model forwards a scope or `def self.` to the model's class,
 * so `Firm.without_deleted.available_for(x)` is `Firm.available_for` and
 * `dir.documents.ordered` the scope on the association's model.
 *
 * The receiver is typed by the same propagation engine `chainType` uses, its
 * head falling back to the naming convention (bd tea-rags-mcp-2m83f.32.5) — query
 * methods keep the relation, a scope returns it, a concern's scope is
 * substituted with the receiver's model. The member is looked up class-side
 * through the model's MRO (the model, its concerns, `ApplicationRecord`); only a
 * pinned definition is an edge.
 *
 * Placed right after `chainType`, which CONTINUEs on any container, and before
 * `arRelationGuard`, which DROPs a query-builder chain it cannot type.
 */
export class RubyRelationChainSymbolResolutionStrategy extends OrmRelationChainSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    const ports: OrmRelationPorts = {
      vocabularyActive: railsVocabularyActive,
      relationModelOf: activeRecordRelationModel,
      memberOnModel: (model, member, ctx) => resolveTypeStaticMethod(model, member, ctx, cfg.mode),
    };
    super(
      "relationChain",
      {
        // The convention root is safe here only because the member must be pinned on the model.
        typeOfReceiver: (call, ctx) =>
          typeOfReceiver(call.receiver, call.startLine, ctx, call.startColumn) ??
          typeOfConventionRootedReceiver(call.receiver, call.startLine, ctx, call.startColumn) ??
          null,
      },
      ports,
    );
  }
}
