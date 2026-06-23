import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { isExternalBareCall } from "../dsl/index.js";
import { resolveConstant } from "./strategies/index.js";

/**
 * Ruby implementation of `ExternalVocabulary`, bridging the `dsl/` framework
 * registry (bare-call names) with the resolver's `resolveConstant` (qualified
 * receivers). A no-receiver member is external iff it is a registered framework
 * macro / runtime / kernel name (`isExternalBareCall`). A constant receiver
 * (`Net::HTTP`, `Base64`) is external iff `resolveConstant` cannot map it to a
 * project / Zeitwerk file — a gem or stdlib constant. A lowercase receiver
 * (local var / `self`) cannot be told apart from a project method, so it stays
 * non-external (conservative). A project method shadowing a framework name
 * resolves first via the chain and never reaches this hook (tea-rags-mcp-5os8y).
 */
export class RubyExternalVocabulary implements ExternalVocabulary {
  isBareCallExternal(member: string): boolean {
    return isExternalBareCall(member);
  }

  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
    return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
  }
}
