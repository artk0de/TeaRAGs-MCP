/**
 * TypeScript's own type-level operators — the complete GENERIC `type X<…> = …`
 * list from `lib.es5.d.ts`, which is where every one of them is declared.
 * `tests/core/domains/language/typescript/utility-types.test.ts` derives the
 * same set from the installed compiler's `lib.es5.d.ts` and fails when the two
 * disagree, so the list below is a pinned copy of the default lib, not a
 * curated one.
 *
 * These are not types in the nominal sense. Each is a FUNCTION over types, and
 * the name records which transformation was applied, not what the value is:
 * `Awaited<ReturnType<EmbeddingProvider["embedBatch"]>>` is an array of
 * numbers, and the name says `Awaited`. Two readers rely on that:
 *
 * - the resolver's external-call guard (`ts-external-call.ts`): a receiver
 *   annotated with one carries no nominal information, and treating the name as
 *   a type the guard may decide on is what produced the measured defect (bd
 *   tea-rags-mcp-yjqi5). Distinct from the exclusion noted on
 *   `ECMASCRIPT_BUILTIN_TYPES`: that set omits these because they are not
 *   BUILTIN INSTANCES; this set says the stronger thing — they are not evidence
 *   either way. `ReadonlyMap` / `ReadonlySet` / `ReadonlyArray` are absent for
 *   exactly that reason: they DENOTE a builtin instance;
 * - the walker's type-abstractness census (`walker/passes/type-abstractness.ts`):
 *   `const handlers: Record<string, Handler> = { … }` names no contract the
 *   literal implements, so it is not counted as a concrete type (bd
 *   tea-rags-mcp-mqaj7).
 */
export const TS_UTILITY_TYPES: ReadonlySet<string> = new Set([
  // Object shape transformations
  "Partial",
  "Required",
  "Readonly",
  "Record",
  "Pick",
  "Omit",
  // Union filters
  "Exclude",
  "Extract",
  "NonNullable",
  "NoInfer",
  // Function / constructor introspection
  "Parameters",
  "ConstructorParameters",
  "ReturnType",
  "InstanceType",
  "ThisParameterType",
  "OmitThisParameter",
  // Promise unwrapping
  "Awaited",
  // String-literal transformations
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
]);
