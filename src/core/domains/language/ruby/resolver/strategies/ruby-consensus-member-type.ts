/**
 * Ruby's `ownerIndependentMemberType` port — the consensus return type of an
 * overflow member (bd tea-rags-mcp-2m83f.42).
 *
 * `record.firm` with an untyped `record` has hundreds of project candidates on
 * TaxDome, and every one of them is a `belongs_to :firm` reader returning
 * `Firm`. The kernel's {@link consensusType} agrees over each candidate's
 * owner-qualified return — read through {@link returnTypeOf}, the one channel
 * authority — so the chain resumes from `Firm` and `record.firm.name` reaches
 * `Firm#name`.
 *
 * Rails-gated: the facts it agrees over are mostly association readers. A
 * candidate that is not an instance method (`def self.firm`, a top-level def)
 * or is a schema column, whose type no channel carries here, refuses the whole
 * agreement.
 */

import type { CallContext, SymbolDefinition } from "../../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { consensusType, RunScopedMemo } from "../../../kernel/index.js";
import { rubyTypeRefEquals } from "../../type-ref.js";
import { railsVocabularyActive } from "./rails-vocabulary-gate.js";
import { returnTypeOf } from "./ruby-member-return-types.js";
import { lookupRubySymbolsByShortName } from "./short-name-lookup.js";

/**
 * One run's answers, keyed beneath the run by the facts they were read from;
 * `null` records a refusal.
 */
const consensusMemo = new RunScopedMemo<object, Map<string, RubyTypeRef | null>>();

export function rubyConsensusMemberType(member: string, ctx: CallContext): RubyTypeRef | undefined {
  const facts = ctx.structuredReturnTypes;
  if (facts === undefined || !railsVocabularyActive(ctx)) return undefined;
  let byMember = consensusMemo.get(ctx.runScope, facts);
  if (byMember === undefined) {
    byMember = new Map();
    consensusMemo.set(ctx.runScope, facts, byMember);
  }
  const memoized = byMember.get(member);
  if (memoized !== undefined) return memoized ?? undefined;
  const candidates = lookupRubySymbolsByShortName(ctx, member, { role: "callee", includeSchemaColumns: true });
  const agreed = consensusType(candidates, (def) => candidateReturnType(def, member, ctx), rubyTypeRefEquals);
  byMember.set(member, agreed ?? null);
  return agreed;
}

/** What one candidate `Owner#member` yields on an `Owner` instance, or `undefined`. */
function candidateReturnType(def: SymbolDefinition, member: string, ctx: CallContext): RubyTypeRef | undefined {
  if (def.isSchemaColumn === true) return undefined;
  const suffix = `#${member}`;
  if (!def.symbolId.endsWith(suffix) || def.symbolId.length === suffix.length) return undefined;
  return returnTypeOf({ form: "instance", name: def.symbolId.slice(0, -suffix.length) }, member, ctx);
}
