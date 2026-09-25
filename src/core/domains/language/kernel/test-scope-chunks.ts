/**
 * Test-scope chunk emission — the half of a test-spec chunker that is the same
 * for every language (bd tea-rags-mcp-msv3l, epic tea-rags-mcp-phftd).
 *
 * A language's scope chunker reads its own AST into the neutral `TestScope`
 * tree (`contracts/types/chunker.ts`) and hands it here; this module decides
 * what the chunks are, what they are called and which lines they cover. Owning
 * that once is what makes a test file's outline read the same in every
 * language, and what keeps the symbolId shape out of eight hooks.
 *
 * The unit is the EXAMPLE. Every example is its own chunk — inherited ancestor
 * setup, then its scope's own setup and other lines, then the example — so
 * `find_symbol` can address one example and get back something runnable in the
 * head. Scopes are not chunks: they are the `parentSymbolId` their examples
 * share, which is how the explore side draws a scope and outlines it. The one
 * exception is a leaf with setup and no examples, which has nothing else to
 * carry it.
 *
 * symbolIds (`.claude/rules/test-spec-chunking.md`):
 *   scope    `${topLevelName}.${scope.name}`
 *   example  `${scopeId}.${example.name}`
 * A repeated id gets `~N` (1-based, the first occurrence unchanged), counted in
 * source order over the whole tree — the same convention
 * `SymbolIdDisambiguator` applies to overloads, applied here because hook body
 * chunks never pass through it. A scope's `~N` carries into its examples' ids.
 * An example's `parentType` is `TEST_SCOPE_PARENT_TYPE`: its parent is a scope,
 * not the AST container the engine would stamp, and that type is the one signal
 * explore reads to tell an example from a setup-only scope.
 *
 * Lives on the SHARED `chunking` axis, not the kernel's `walker` axis
 * (`capability/version-axes.ts`): it moves chunks, never edges.
 */

import {
  TEST_SCOPE_PARENT_TYPE,
  type BodyChunkResult,
  type HookChunkingConfig,
  type TestExample,
  type TestScope,
  type TestScopeLine,
} from "../../../contracts/types/chunker.js";

/** Chunks shorter than this (after trim) carry no searchable signal and are dropped. */
const MIN_TEST_CHUNK_CONTENT = 50;

type ScopeEvent = { kind: "scope"; scope: TestScope; ancestors: TestScope[] };
type ExampleEvent = { kind: "example"; example: TestExample; scope: TestScope; ancestors: TestScope[] };

/**
 * Emit the chunks of one test scope tree. `topLevelName` is the language's
 * reading of the root container's subject (`Worker` for
 * `RSpec.describe Worker`), the first segment of every id.
 */
export function produceTestScopeChunks(
  root: TestScope,
  topLevelName: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  // The engine emits every chunk under the container header(s); the example
  // has only what is left of the cap (bd tea-rags-mcp-pi1cl).
  const contentBudget = config.maxChunkSize - (config.bodyChunkPrefixLength ?? 0);
  const occurrences = new Map<string, number>();
  const disambiguate = (baseId: string): string => {
    const next = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, next);
    return next === 1 ? baseId : `${baseId}~${next}`;
  };

  const scopeIds = new Map<TestScope, string>();
  const results: BodyChunkResult[] = [];

  for (const event of sourceOrder(root, [])) {
    if (event.kind === "scope") {
      const scopeId = disambiguate(`${topLevelName}.${event.scope.name}`);
      scopeIds.set(event.scope, scopeId);
      const setupChunk = setupOnlyChunk(event.scope, scopeId, topLevelName);
      if (setupChunk) results.push(setupChunk);
      continue;
    }

    const scopeId = scopeIds.get(event.scope) as string;
    const symbolId = disambiguate(`${scopeId}.${event.example.name}`);
    const content = exampleContent(event.example, event.scope, event.ancestors, contentBudget);
    if (content.length < MIN_TEST_CHUNK_CONTENT) continue;
    results.push({
      content,
      startLine: event.example.startLine,
      endLine: event.example.endLine,
      chunkType: "test",
      symbolId,
      name: event.example.name,
      parentSymbolId: scopeId,
      parentType: TEST_SCOPE_PARENT_TYPE,
    });
  }

  return results;
}

/**
 * Scopes and examples interleaved by start line, a scope before anything it
 * contains. The order ids are counted in, and the order chunks are emitted in.
 */
function* sourceOrder(scope: TestScope, ancestors: TestScope[]): Generator<ScopeEvent | ExampleEvent> {
  yield { kind: "scope", scope, ancestors };
  const inner = [...ancestors, scope];
  const members: (TestScope | TestExample)[] = [...scope.children, ...scope.examples].sort(
    (a, b) => a.startLine - b.startLine,
  );
  for (const member of members) {
    if (isScope(member)) yield* sourceOrder(member, inner);
    else yield { kind: "example", example: member, scope, ancestors };
  }
}

function isScope(member: TestScope | TestExample): member is TestScope {
  return "children" in member;
}

/**
 * Inherited setup (outermost ancestor first), the scope's own setup and other
 * lines, then the example. When that exceeds the budget (`maxChunkSize` less
 * the header prefix the engine prepends) the prefix sheds
 * whole statements from the OUTERMOST end first, so the context nearest the
 * example survives longest and the example itself is never cut here — an
 * example that is oversized on its own is left to the engine's hard cap.
 */
function exampleContent(example: TestExample, scope: TestScope, ancestors: TestScope[], maxChunkSize: number): string {
  const prefix: string[] = [
    ...ancestors.flatMap((ancestor) => ancestor.setupLines.map((s) => s.text)),
    ...scope.setupLines.map((s) => s.text),
    ...scope.otherLines.map((o) => o.text),
  ];
  let start = 0;
  const lengthFrom = (from: number): number =>
    prefix.slice(from).reduce((sum, text) => sum + text.length + 1, 0) + example.text.length;
  while (start < prefix.length && lengthFrom(start) > maxChunkSize) start++;
  return [...prefix.slice(start), example.text].join("\n").trim();
}

/**
 * A leaf with setup and no examples: one chunk of its own lines, named after
 * the scope. A `test` when a setup line runs shared examples, else
 * `test_setup`. Any scope with children or examples yields nothing here — its
 * setup reaches the index inside its examples.
 */
function setupOnlyChunk(scope: TestScope, scopeId: string, topLevelName: string): BodyChunkResult | undefined {
  if (scope.children.length > 0 || scope.examples.length > 0) return undefined;
  const own: TestScopeLine[] = [...scope.setupLines, ...scope.otherLines];
  if (own.length === 0) return undefined;
  const content = own
    .map((l) => l.text)
    .join("\n")
    .trim();
  if (content.length < MIN_TEST_CHUNK_CONTENT) return undefined;
  const lines = own.map((l) => l.sourceLine);
  return {
    content,
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    chunkType: scope.setupLines.some((s) => s.delegatesExamples === true) ? "test" : "test_setup",
    symbolId: scopeId,
    name: scope.name,
    parentSymbolId: topLevelName,
  };
}
