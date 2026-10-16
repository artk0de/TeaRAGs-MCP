import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import type { CallContext, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  OrmRelationChainSymbolResolutionStrategy,
  propagateReceiverType,
  type OrmRelationPorts,
} from "../../../kernel/index.js";
import { pythonVocabularyFor } from "../../vocabulary/frameworks/index.js";
import { placePythonClassSpelling, type PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { parsePythonClassKey } from "./python-class-key.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { resolvePythonInheritedMember } from "./python-inherited-member.js";
import { pythonDescendsFromAny } from "./python-member-return-types.js";
import { createPythonReceiverTypePorts } from "./python-receiver-type-ports.js";
import { lastSegment, pythonTypeRefClassKey } from "./python-type-addressing.js";
import type { ResolverConfig } from "./shared.js";

/** Django is declared — or there is no manifest, which reads every vocabulary as active. */
export function djangoVocabularyActive(ctx: CallContext): boolean {
  return pythonVocabularyFor(ctx.declaredDependencies).hasFacet("relationReturning");
}

/**
 * The model a FRAMEWORK relation ranges over — `QuerySet[Book]`,
 * `Manager[Book]`, spelled by the framework's own class with the model in
 * `args`. A project queryset is no answer here: it names the class its members
 * live on, so `chainType` resolves it directly.
 */
export function pythonRelationModelOf(type: TypeRef, ctx: CallContext): string | undefined {
  if (type.form !== "instance") return undefined;
  const model = type.args?.[0];
  if (model?.form !== "instance") return undefined;
  const carrier = lastSegment(type.name);
  for (const vocabulary of pythonVocabularyFor(ctx.declaredDependencies).memberTypes) {
    if (vocabulary.relationClasses.has(carrier)) return model.name;
  }
  return undefined;
}

/**
 * The Django port of the kernel's ORM relation chain (bd tea-rags-mcp-2m83f.32.4):
 * a relation the fold only knows as Django's own `QuerySet[Book]`
 * (`Book._default_manager.exclude(...)`) forwards a custom queryset method to
 * the class one of `Book`'s managers carries — `objects =
 * BookQuerySet.as_manager()`, or a manager built by `from_queryset`, whose MRO
 * holds the queryset. Managers are read along the model's C3 MRO, so an
 * abstract base's manager counts; the member must pin to ONE definition across
 * them, or two managers disagree and the call has no edge.
 *
 * Model methods are not looked up: a `QuerySet` forwards nothing to its model.
 *
 * Placed right after `chainType`, which spares a framework relation of a model
 * from its typed-miss DROP; this pass DROPs that miss instead, so the
 * short-name passes never guess at a relation's member.
 */
export class PythonRelationChainSymbolResolutionStrategy extends OrmRelationChainSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig, mapper: PythonImportFileMapper, linearizers: PythonAncestorLinearizerCache) {
    const typing = createPythonReceiverTypePorts(mapper, linearizers);
    const ports: OrmRelationPorts = {
      vocabularyActive: djangoVocabularyActive,
      relationModelOf: pythonRelationModelOf,
      memberOnModel: (model, member, ctx) => {
        const linearizer = linearizers.for(ctx);
        const modelKey = pythonTypeRefClassKey(model, ctx, mapper);
        if (linearizer === undefined || modelKey === null) return null;
        const relationClasses = new Set(
          pythonVocabularyFor(ctx.declaredDependencies).memberTypes.flatMap((vocabulary) => [
            ...vocabulary.relationClasses,
          ]),
        );
        const targets = new Map<string, SymbolResolutionTarget>();
        for (const key of new Set([modelKey, ...linearizer.linearize(modelKey).order])) {
          const parsed = parsePythonClassKey(key);
          if (parsed === null) continue;
          for (const spelling of Object.values(identifierEntry(ctx.classFieldTypesByClassKey, key) ?? {})) {
            const manager = placePythonClassSpelling(spelling, parsed.relPath, ctx, mapper);
            if (manager.kind !== "project") continue;
            if (!pythonDescendsFromAny(manager.classKey, relationClasses, ctx, mapper, linearizer)) continue;
            const { target } = resolvePythonInheritedMember(manager.classKey, member, ctx, cfg.mode, linearizer);
            if (target?.targetSymbolId) targets.set(target.targetSymbolId, target);
          }
        }
        return targets.size === 1 ? [...targets.values()][0] : null;
      },
    };
    super(
      "relationChain",
      { typeOfReceiver: (call, ctx) => propagateReceiverType(call.receiver, call.startLine, ctx, typing) ?? null },
      ports,
      { dropOnMiss: true },
    );
  }
}
