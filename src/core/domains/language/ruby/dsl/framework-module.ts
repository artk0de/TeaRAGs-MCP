import type { RubyDslEntry, RubyFrameworkVocabulary } from "./types.js";

/**
 * Build a `RubyFrameworkVocabulary` from a framework's declaring macros
 * (`entries`) and optional runtime helpers (`runtimeBuiltins`). The membership
 * logic — entries-key OR runtime-builtin — lives HERE once, so no consumer
 * reaches into the storage shape (`Record` key test vs `Set.has`). A factory,
 * not a container: each framework module calls it with its own data.
 */
export function defineFrameworkVocabulary(
  framework: string,
  entries: Record<string, RubyDslEntry>,
  runtimeBuiltins?: ReadonlySet<string>,
): RubyFrameworkVocabulary {
  return {
    framework,
    entries,
    runtimeBuiltins,
    hasExternalMember: (member) => member in entries || (runtimeBuiltins?.has(member) ?? false),
  };
}
