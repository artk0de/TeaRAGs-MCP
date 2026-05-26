import type { CallContext, CallRef, ResolvedTarget } from "../../contracts/types/codegraph.js";
import type { ResolverComponent } from "../../contracts/types/language.js";

/**
 * Drive an ordered chain of resolver components, returning the first non-null
 * hit. The order IS the resolution precedence — a component earlier in the
 * array wins over a later one for the same call. This is the language-neutral
 * engine a per-language `LanguageSymbolResolver` uses to run its
 * `ResolverComponent[]`.
 */
export function resolveViaChain(
  components: readonly ResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): ResolvedTarget | null {
  for (const component of components) {
    const hit = component.resolve(call, ctx);
    if (hit) return hit;
  }
  return null;
}
