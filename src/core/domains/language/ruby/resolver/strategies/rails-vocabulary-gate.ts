import type { CallContext } from "../../../../../contracts/types/codegraph.js";
import { RAILS_RESIDUAL_FRAMEWORK_MEMBERS } from "../../dsl/index.js";

/** Rails is in the Gemfile — or there is no Gemfile, which reads every vocabulary as active. */
export function railsVocabularyActive(ctx: CallContext): boolean {
  const gems = ctx.declaredDependencies;
  if (gems === undefined) return true;
  for (const gem of RAILS_RESIDUAL_FRAMEWORK_MEMBERS.gems) if (gems.has(gem)) return true;
  return false;
}
