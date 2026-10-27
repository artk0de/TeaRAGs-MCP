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
 * The unit is the EXAMPLE: every example is addressable by its own id — its
 * scope title path, then the example. Adjacent examples of one scope are
 * PACKED into one chunk up to `EXAMPLE_GROUP_BUDGET_CHARS` (bd
 * tea-rags-mcp-g5i0a), each member carrying its id, line range and row count,
 * so `find_symbol` still answers one example with that example alone. Setup is
 * stored ONCE per scope (bd tea-rags-mcp-5xpq4): the own setup and other lines
 * of consecutive scopes are PACKED into one `test_setup` chunk up to the
 * content budget (one chunk per scope doubled the point count of a
 * context-heavy spec), each member carrying its scope's whole line span
 * (`scopeLineRanges`) and its row count (`memberRowCounts`). An example
 * inherits every member whose span contains its start line — lexical
 * inheritance, no id parsing — and explore prepends those members' rows when
 * it returns the example. That
 * keeps the example "runnable in the head" without embedding the same `let` /
 * `beforeEach` once per example — on taxdome that repetition had tests embedded
 * at x1.75 of their source size.
 *
 * Examples too short to carry a searchable signal on their own
 * (`it { is_expected.to be_valid }`) are never dropped: alone in their run,
 * they join the nearest pack of their scope. A pack chunk, like a setup pack,
 * is named after its first member and lists every member in
 * `memberSymbolIds`, the field `find_symbol` answers a member id from.
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
 * explore reads to tell an example from a scope's setup chunk.
 *
 * The ids, chunk types and packing above are the TEST vocabulary
 * (`TEST_SCOPE_CHUNK_VOCABULARY`, the default). A DSL that is not a test —
 * Rake, bd tea-rags-mcp-k0602 — reads its AST into the same tree and passes
 * its own `ScopeChunkVocabulary`: the scope-tree machinery is shared, only the
 * naming and the chunk kinds differ.
 *
 * Lives on the SHARED `chunking` axis, not the kernel's `walker` axis
 * (`capability/version-axes.ts`): it moves chunks, never edges.
 */

import {
  bodyChunkContentBudget,
  TEST_SCOPE_PARENT_TYPE,
  type BodyChunkResult,
  type ChunkType,
  type HookChunkingConfig,
  type TestExample,
  type TestScope,
  type TestScopeLine,
} from "../../../contracts/types/chunker.js";

/**
 * How a scope DSL names and types its chunks — the part of emission that
 * differs between a test DSL and a production one. The tree reading, source
 * order, `~N`, title rows and setup packing are the same for every vocabulary.
 */
export interface ScopeChunkVocabulary {
  /** Joins the segments of a symbolId. */
  idSeparator: string;
  /**
   * `subject`: a scope is `<topLevelName><sep><scope>` — its IMMEDIATE name
   * under the root's subject (RSpec, Jest). `namespace`: a scope is its
   * parent's id, then its own segment — the full path, root first (Rake).
   */
  idPath: "subject" | "namespace";
  /** chunkType of a leaf (an example, a task) and of a setup scope that delegates to leaves. */
  leafChunkType: ChunkType;
  /** chunkType of a scope's own setup and other lines. */
  setupChunkType: ChunkType;
  /** parentType of a leaf; absent → the container's AST type, as for any other body chunk. */
  leafParentType?: string;
  /** Pack adjacent leaves of one scope into one chunk (bd tea-rags-mcp-g5i0a); else every leaf is its own chunk. */
  packLeaves: boolean;
  /** Below this a leafless scope's own lines are dropped as noise. */
  minSetupContent: number;
}

/**
 * Below this (after trim) a chunk carries no searchable signal of its own: an
 * example is grouped with its tiny siblings, a setup-only leaf is dropped.
 */
const MIN_TEST_CHUNK_CONTENT = 50;

/** The test-spec vocabulary every test DSL chunker emits under (`.claude/rules/test-spec-chunking.md`). */
export const TEST_SCOPE_CHUNK_VOCABULARY: ScopeChunkVocabulary = {
  idSeparator: ".",
  idPath: "subject",
  leafChunkType: "test",
  setupChunkType: "test_setup",
  leafParentType: TEST_SCOPE_PARENT_TYPE,
  packLeaves: true,
  minSetupContent: MIN_TEST_CHUNK_CONTENT,
};

/**
 * The most characters one pack of adjacent examples may hold (bd
 * tea-rags-mcp-g5i0a). Packing only examples under `MIN_TEST_CHUNK_CONTENT`
 * grouped 7 of 74,952 test points on the taxdome index; one point per example
 * of a one-line-assertion spec is the same tiny-chunk problem the setup packs
 * solved. 1500 holds the run of short siblings a policy or component spec is
 * made of while staying a third of the 4500 chunk cap, so a search hit still
 * reads as a handful of examples rather than a file.
 */
export const EXAMPLE_GROUP_BUDGET_CHARS = 1500;

type ScopeEvent = { kind: "scope"; scope: TestScope; ancestors: TestScope[] };
type ExampleEvent = { kind: "example"; example: TestExample; scope: TestScope; ancestors: TestScope[] };

/** A scope's own setup, waiting to be packed with its neighbours'. */
interface PendingSetup {
  scope: TestScope;
  scopeId: string;
  /** The enclosing scope's id; absent on the root. */
  parentScopeId?: string;
  content: string;
  startLine: number;
  endLine: number;
  /** A setup line runs shared examples: the scope keeps a `test` chunk of its own. */
  delegates: boolean;
}

/** An example with its id and its own (ungrouped) content, waiting to be emitted. */
interface PendingExample {
  example: TestExample;
  scope: TestScope;
  symbolId: string;
  header: string[];
  content: string;
}

/**
 * Emit the chunks of one test scope tree. `topLevelName` is the language's
 * reading of the root container's subject (`Worker` for
 * `RSpec.describe Worker`), the first segment of every id under the `subject`
 * id path; the `namespace` path ignores it.
 */
export function produceTestScopeChunks(
  root: TestScope,
  topLevelName: string,
  config: HookChunkingConfig,
  vocabulary: ScopeChunkVocabulary = TEST_SCOPE_CHUNK_VOCABULARY,
): BodyChunkResult[] {
  const sep = vocabulary.idSeparator;
  // The engine emits every chunk under the container header(s); the example
  // has only what is left of the cap (bd tea-rags-mcp-pi1cl).
  const contentBudget = bodyChunkContentBudget(config);
  const occurrences = new Map<string, number>();
  const disambiguate = (baseId: string): string => {
    const next = (occurrences.get(baseId) ?? 0) + 1;
    occurrences.set(baseId, next);
    return next === 1 ? baseId : `${baseId}~${next}`;
  };

  const scopeIds = new Map<TestScope, string>();
  // Source order: a scope's setup waiting for packing, or an example waiting
  // for grouping.
  const slots: (PendingSetup | PendingExample)[] = [];
  const pendingOf = new Map<TestExample, PendingExample>();

  for (const event of sourceOrder(root, [])) {
    if (event.kind === "scope") {
      const parent = event.ancestors.at(-1);
      const parentScopeId = parent === undefined ? undefined : scopeIds.get(parent);
      // The id's prefix: the root's subject (`subject` path), else the parent
      // scope's own id, `~N` included (`namespace` path; none on the root).
      const prefix = vocabulary.idPath === "subject" ? topLevelName : parentScopeId;
      const segment = event.scope.idName ?? event.scope.name;
      const scopeId = disambiguate(prefix === undefined ? segment : `${prefix}${sep}${segment}`);
      scopeIds.set(event.scope, scopeId);
      const setup = pendingScopeSetup(event.scope, scopeId, parentScopeId, vocabulary.minSetupContent);
      if (setup) slots.push(setup);
      continue;
    }

    const scopeId = scopeIds.get(event.scope) as string;
    const leafSegment = event.example.idName ?? event.example.name;
    // The root's own call row is the container header the engine prepends.
    const header = [...event.ancestors, event.scope].slice(1).map((s) => s.name);
    const pending: PendingExample = {
      example: event.example,
      scope: event.scope,
      symbolId: disambiguate(event.example.idUnscoped ? leafSegment : `${scopeId}${sep}${leafSegment}`),
      header,
      content: withScopeHeader(header, event.example.text, contentBudget),
    };
    pendingOf.set(event.example, pending);
    slots.push(pending);
  }

  // Each example pack is emitted at the slot of its earliest member.
  const groupAt = new Map<PendingExample, PendingExample[]>();
  const grouped = new Set<PendingExample>();
  for (const scope of vocabulary.packLeaves ? scopesOf(root) : []) {
    for (const group of examplePacks(scope, pendingOf, contentBudget)) {
      groupAt.set(group[0], group);
      for (const member of group) grouped.add(member);
    }
  }

  // Setup is packed across scopes (bd tea-rags-mcp-5xpq4): one chunk per
  // scope doubled the point count of a context-heavy spec with chunks of a
  // line or two. Each pack is emitted at the slot of its first member; a
  // delegating scope keeps a chunk of its own.
  const setups = slots.filter((slot): slot is PendingSetup => !isPending(slot));
  const packAt = new Map<PendingSetup, PendingSetup[]>();
  for (const pack of packSetups(
    setups.filter((s) => !s.delegates),
    contentBudget,
  )) {
    packAt.set(pack[0], pack);
  }
  for (const setup of setups) if (setup.delegates) packAt.set(setup, [setup]);

  const results: BodyChunkResult[] = [];
  for (const slot of slots) {
    if (!isPending(slot)) {
      const pack = packAt.get(slot);
      if (pack) {
        // `subject` parents every setup pack under the root's subject;
        // `namespace` under the enclosing scope (none on the root: the engine
        // then names the container, as for any body chunk).
        const parentSymbolId = vocabulary.idPath === "subject" ? topLevelName : pack[0].parentScopeId;
        results.push(setupChunk(pack, parentSymbolId, vocabulary));
      }
      continue;
    }
    const group = groupAt.get(slot);
    if (group) {
      results.push(groupChunk(group, scopeIds.get(slot.scope) as string, contentBudget, vocabulary));
      continue;
    }
    if (grouped.has(slot)) continue;
    results.push({
      content: slot.content,
      startLine: slot.example.startLine,
      endLine: slot.example.endLine,
      chunkType: vocabulary.leafChunkType,
      symbolId: slot.symbolId,
      name: slot.example.idName ?? slot.example.name,
      parentSymbolId: scopeIds.get(slot.scope),
      ...(vocabulary.leafParentType === undefined ? {} : { parentType: vocabulary.leafParentType }),
      // The example's call row. An example oversized on its own sheds every
      // title row above, so it opens its chunk, and the engine repeats it on
      // every `#part2+` it cuts (bd tea-rags-mcp-l24yk).
      partHeader: slot.example.text.split("\n", 1)[0].trim(),
    });
  }

  return results;
}

function isPending(slot: PendingSetup | PendingExample): slot is PendingExample {
  return "example" in slot;
}

/**
 * Scopes and examples interleaved by start line, a scope before anything it
 * contains. The order ids are counted in, and the order chunks are emitted in.
 */
function* sourceOrder(scope: TestScope, ancestors: TestScope[]): Generator<ScopeEvent | ExampleEvent> {
  yield { kind: "scope", scope, ancestors };
  const inner = [...ancestors, scope];
  for (const member of membersOf(scope)) {
    if (isScope(member)) yield* sourceOrder(member, inner);
    else yield { kind: "example", example: member, scope, ancestors };
  }
}

/** A scope's direct children and examples, by start line. */
function membersOf(scope: TestScope): (TestScope | TestExample)[] {
  return [...scope.children, ...scope.examples].sort((a, b) => a.startLine - b.startLine);
}

function isScope(member: TestScope | TestExample): member is TestScope {
  return "children" in member;
}

/** Every scope of the tree, a scope before its children. */
function scopesOf(scope: TestScope): TestScope[] {
  return [scope, ...scope.children.flatMap(scopesOf)];
}

/**
 * The scope title path (the non-root scope names, outermost first), then the
 * body. When that exceeds the budget (`maxChunkSize` less the header prefix the
 * engine prepends) the title rows shed from the OUTERMOST end first, so the row
 * nearest the example survives longest and the example itself is never cut
 * here — an example that is oversized on its own is left to the engine's hard
 * cap.
 */
function withScopeHeader(header: string[], body: string, maxChunkSize: number): string {
  let start = 0;
  const lengthFrom = (from: number): number =>
    header.slice(from).reduce((sum, text) => sum + text.length + 1, 0) + body.length;
  while (start < header.length && lengthFrom(start) > maxChunkSize) start++;
  return [...header.slice(start), body].join("\n").trim();
}

/**
 * The example packs of one scope (bd tea-rags-mcp-g5i0a). A run is the
 * examples of the scope with no child scope between them — packing never
 * crosses one, and every member therefore shares one setup chain. Its own
 * setup lines between two examples do not break a run: they live in the
 * scope's setup chunk, so no example text is re-ordered around them.
 *
 * Each run is cut greedily, in source order, into packs whose content stays
 * within the pack budget (`EXAMPLE_GROUP_BUDGET_CHARS`, never above the
 * engine's content budget); an example over the budget on its own stays
 * single. A lone tiny example — the only example of its run, under
 * `MIN_TEST_CHUNK_CONTENT` — first joins the nearest run of several in its
 * scope, or with none to join the other lone tiny ones, so the bd
 * tea-rags-mcp-5xpq4 grouping of signal-free examples still holds across a
 * child scope. Packs of one are not returned: that example is emitted as itself.
 */
function examplePacks(
  scope: TestScope,
  pendingOf: Map<TestExample, PendingExample>,
  contentBudget: number,
): PendingExample[][] {
  const runs: PendingExample[][] = [];
  let run: PendingExample[] = [];
  for (const member of membersOf(scope)) {
    const pending = isScope(member) ? undefined : pendingOf.get(member);
    if (pending) {
      run.push(pending);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);

  const groups = runs.filter((r) => r.length > 1);
  const singles = runs.filter((r) => r.length === 1).map((r) => r[0]);
  // Judged on the example's own text: the title rows are context, and a header
  // long enough to clear the floor would carry an example whose own signal is
  // still nil (bd tea-rags-mcp-5xpq4 — grouped, not header-padded).
  const lones = singles.filter((s) => s.example.text.trim().length < MIN_TEST_CHUNK_CONTENT);
  if (groups.length === 0) {
    if (lones.length > 1) groups.push(lones);
  } else {
    for (const lone of lones) nearestGroup(groups, lone).push(lone);
  }
  const packBudget = Math.min(EXAMPLE_GROUP_BUDGET_CHARS, contentBudget);
  return groups.flatMap((group) =>
    cutAtBudget(
      group.sort((a, b) => a.example.startLine - b.example.startLine),
      packBudget,
      contentBudget,
    ).filter((piece) => piece.length > 1),
  );
}

function nearestGroup(groups: PendingExample[][], lone: PendingExample): PendingExample[] {
  const distance = (group: PendingExample[]): number =>
    Math.min(...group.map((member) => Math.abs(member.example.startLine - lone.example.startLine)));
  return groups.reduce((best, group) => (distance(group) < distance(best) ? group : best));
}

/** Consecutive pieces of a group, each fitting the pack budget under the scope title path. */
function cutAtBudget(members: PendingExample[], packBudget: number, contentBudget: number): PendingExample[][] {
  const pieces: PendingExample[][] = [];
  let piece: PendingExample[] = [];
  for (const member of members) {
    const candidate = [...piece, member];
    if (piece.length > 0 && groupContent(candidate, contentBudget).length > packBudget) {
      pieces.push(piece);
      piece = [member];
    } else {
      piece = candidate;
    }
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function groupContent(members: PendingExample[], budget: number): string {
  return withScopeHeader(members[0].header, members.map((m) => m.example.text.trim()).join("\n"), budget);
}

/**
 * One chunk packing adjacent examples of one scope, named after its first
 * member. Per member, aligned and in source order — the shape a setup pack
 * carries: its id (`memberSymbolIds`), its own line range (`lineRanges`) and
 * its row count in `content` after the scope title rows (`memberRowCounts`),
 * which is what lets explore answer one member's id with that member alone.
 */
function groupChunk(
  members: PendingExample[],
  scopeId: string,
  budget: number,
  vocabulary: ScopeChunkVocabulary,
): BodyChunkResult {
  const [first] = members;
  const last = members[members.length - 1];
  return {
    content: groupContent(members, budget),
    startLine: first.example.startLine,
    endLine: last.example.endLine,
    lineRanges: members.map((m) => ({ start: m.example.startLine, end: m.example.endLine })),
    chunkType: vocabulary.leafChunkType,
    symbolId: first.symbolId,
    name: first.example.idName ?? first.example.name,
    parentSymbolId: scopeId,
    ...(vocabulary.leafParentType === undefined ? {} : { parentType: vocabulary.leafParentType }),
    memberRowCounts: members.map((m) => m.example.text.trim().split("\n").length),
    memberSymbolIds: members.map((m) => m.symbolId),
  };
}

/**
 * A scope's own setup and other lines, waiting to be packed. Kept whatever its
 * size when an example below depends on it — hydration renders it into those
 * examples; a leaf with setup and nothing else must clear the minimum like any
 * other chunk.
 */
function pendingScopeSetup(
  scope: TestScope,
  scopeId: string,
  parentScopeId: string | undefined,
  minSetupContent: number,
): PendingSetup | undefined {
  const own: TestScopeLine[] = [...scope.setupLines, ...scope.otherLines];
  if (own.length === 0) return undefined;
  const content = own
    .map((l) => l.text)
    .join("\n")
    .trim();
  if (content.length < minSetupContent && !hasExamples(scope)) return undefined;
  const lines = own.map((l) => l.sourceLine);
  return {
    scope,
    scopeId,
    ...(parentScopeId === undefined ? {} : { parentScopeId }),
    content,
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    delegates: scope.setupLines.some((s) => s.delegatesExamples === true),
  };
}

/**
 * Consecutive setup members, in source order, cut into packs that fit the
 * content budget. A member oversized on its own is a pack of one — the
 * engine's hard cap splits it into `#partN` windows.
 */
function packSetups(members: PendingSetup[], budget: number): PendingSetup[][] {
  const packs: PendingSetup[][] = [];
  let pack: PendingSetup[] = [];
  let length = 0;
  for (const member of members) {
    const size = member.content.length;
    const grown = pack.length === 0 ? size : length + 1 + size;
    if (pack.length > 0 && grown > budget) {
      packs.push(pack);
      pack = [member];
      length = size;
    } else {
      pack.push(member);
      length = grown;
    }
  }
  if (pack.length > 0) packs.push(pack);
  return packs;
}

/**
 * One setup chunk carrying the setup of every member scope, in source order.
 * Named after the first member; the vocabulary's leaf type when its member
 * runs shared examples (such a scope is never packed with others), else its
 * setup type (`test` / `test_setup` for tests). Per member, aligned: its
 * scope's span (what an example's start line is matched against), its row
 * count in `content` (what lets hydration render one member alone), and — on
 * a pack of several — its id and own line range.
 */
function setupChunk(
  members: PendingSetup[],
  parentSymbolId: string | undefined,
  vocabulary: ScopeChunkVocabulary,
): BodyChunkResult {
  const [first] = members;
  const packed = members.length > 1;
  return {
    content: members.map((m) => m.content).join("\n"),
    startLine: Math.min(...members.map((m) => m.startLine)),
    endLine: Math.max(...members.map((m) => m.endLine)),
    chunkType: first.delegates ? vocabulary.leafChunkType : vocabulary.setupChunkType,
    symbolId: first.scopeId,
    name: first.scope.idName ?? first.scope.name,
    ...(parentSymbolId === undefined ? {} : { parentSymbolId }),
    ...(packed ? { lineRanges: members.map((m) => ({ start: m.startLine, end: m.endLine })) } : {}),
    scopeLineRanges: members.map((m) => ({ start: m.scope.startLine, end: m.scope.endLine })),
    memberRowCounts: members.map((m) => m.content.split("\n").length),
    ...(packed ? { memberSymbolIds: members.map((m) => m.scopeId) } : {}),
  };
}

function hasExamples(scope: TestScope): boolean {
  return scope.examples.length > 0 || scope.children.some(hasExamples);
}
