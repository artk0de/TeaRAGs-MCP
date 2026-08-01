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
  extras?: Pick<
    RubyFrameworkVocabulary,
    | "instanceReturning"
    | "relationReturning"
    | "enqueueDispatch"
    | "activatedBy"
    | "structuredMacros"
    | "coreAmbiguousMembers"
    | "instanceReceiverPrefixes"
  >,
): RubyFrameworkVocabulary {
  const coreAmbiguousMembers = extras?.coreAmbiguousMembers;
  return {
    framework,
    entries,
    runtimeBuiltins,
    hasExternalMember: (member) => member in entries || (runtimeBuiltins?.has(member) ?? false),
    // bd tea-rags-mcp-83cl7 — the core-member axis is OPT-IN per framework: a gem
    // verb is external, never a core homonym, so a module without the facet
    // answers false and can never shrink the recall denominator.
    hasCoreAmbiguousMember: (member) => coreAmbiguousMembers?.has(member) ?? false,
    ...extras,
  };
}
