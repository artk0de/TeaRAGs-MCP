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
 * The unit is the EXAMPLE. Every example is its own chunk — its scope title
 * path, then the example — so `find_symbol` can address one example. Setup is
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
 * (`it { is_expected.to be_valid }`) are GROUPED with their tiny siblings, never
 * dropped. A group chunk, like a setup pack, is named after its first member
 * and lists every member in `memberSymbolIds`, the field `find_symbol` answers
 * a member id from.
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
 * Lives on the SHARED `chunking` axis, not the kernel's `walker` axis
 * (`capability/version-axes.ts`): it moves chunks, never edges.
 */

import {
  bodyChunkContentBudget,
  TEST_SCOPE_PARENT_TYPE,
  type BodyChunkResult,
  type HookChunkingConfig,
  type TestExample,
  type TestScope,
  type TestScopeLine,
} from "../../../contracts/types/chunker.js";

/**
 * Below this (after trim) a chunk carries no searchable signal of its own: an
 * example is grouped with its tiny siblings, a setup-only leaf is dropped.
 */
const MIN_TEST_CHUNK_CONTENT = 50;

type ScopeEvent = { kind: "scope"; scope: TestScope; ancestors: TestScope[] };
type ExampleEvent = { kind: "example"; example: TestExample; scope: TestScope; ancestors: TestScope[] };

/** A scope's own setup, waiting to be packed with its neighbours'. */
interface PendingSetup {
  scope: TestScope;
  scopeId: string;
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
 * `RSpec.describe Worker`), the first segment of every id.
 */
export function produceTestScopeChunks(
  root: TestScope,
  topLevelName: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
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
      const scopeId = disambiguate(`${topLevelName}.${event.scope.name}`);
      scopeIds.set(event.scope, scopeId);
      const setup = pendingScopeSetup(event.scope, scopeId);
      if (setup) slots.push(setup);
      continue;
    }

    const scopeId = scopeIds.get(event.scope) as string;
    // The root's own call row is the container header the engine prepends.
    const header = [...event.ancestors, event.scope].slice(1).map((s) => s.name);
    const pending: PendingExample = {
      example: event.example,
      scope: event.scope,
      symbolId: disambiguate(`${scopeId}.${event.example.name}`),
      header,
      content: withScopeHeader(header, event.example.text, contentBudget),
    };
    pendingOf.set(event.example, pending);
    slots.push(pending);
  }

  // Each tiny group is emitted at the slot of its earliest member.
  const groupAt = new Map<PendingExample, PendingExample[]>();
  const grouped = new Set<PendingExample>();
  for (const scope of scopesOf(root)) {
    for (const group of tinyGroups(scope, pendingOf, contentBudget)) {
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
      if (pack) results.push(setupChunk(pack, topLevelName));
      continue;
    }
    const group = groupAt.get(slot);
    if (group) {
      results.push(groupChunk(group, scopeIds.get(slot.scope) as string, contentBudget));
      continue;
    }
    if (grouped.has(slot)) continue;
    results.push({
      content: slot.content,
      startLine: slot.example.startLine,
      endLine: slot.example.endLine,
      chunkType: "test",
      symbolId: slot.symbolId,
      name: slot.example.name,
      parentSymbolId: scopeIds.get(slot.scope),
      parentType: TEST_SCOPE_PARENT_TYPE,
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
 * The tiny examples of one scope, grouped. A run of consecutive tiny siblings
 * (no larger example and no child scope between them) is a group; a lone tiny
 * example joins the nearest group of its scope, or — with no group to join —
 * the other lone ones; a single tiny example in its scope stays alone. Each
 * group is cut at the content budget in source order. Groups of one are not
 * returned: that example is emitted as itself.
 */
function tinyGroups(scope: TestScope, pendingOf: Map<TestExample, PendingExample>, budget: number): PendingExample[][] {
  const runs: PendingExample[][] = [];
  let run: PendingExample[] = [];
  for (const member of membersOf(scope)) {
    const pending = isScope(member) ? undefined : pendingOf.get(member);
    // Judged on the example's own text: the title rows are context, and a
    // header long enough to clear the floor would carry an example whose own
    // signal is still nil (bd tea-rags-mcp-5xpq4 — grouped, not header-padded).
    if (pending && pending.example.text.trim().length < MIN_TEST_CHUNK_CONTENT) {
      run.push(pending);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);

  const groups = runs.filter((r) => r.length > 1);
  const lones = runs.filter((r) => r.length === 1).map((r) => r[0]);
  if (groups.length === 0) {
    if (lones.length > 1) groups.push(lones);
  } else {
    for (const lone of lones) nearestGroup(groups, lone).push(lone);
  }
  return groups.flatMap((group) =>
    cutAtBudget(
      group.sort((a, b) => a.example.startLine - b.example.startLine),
      budget,
    ).filter((piece) => piece.length > 1),
  );
}

function nearestGroup(groups: PendingExample[][], lone: PendingExample): PendingExample[] {
  const distance = (group: PendingExample[]): number =>
    Math.min(...group.map((member) => Math.abs(member.example.startLine - lone.example.startLine)));
  return groups.reduce((best, group) => (distance(group) < distance(best) ? group : best));
}

/** Consecutive pieces of a group, each fitting the budget under the scope title path. */
function cutAtBudget(members: PendingExample[], budget: number): PendingExample[][] {
  const pieces: PendingExample[][] = [];
  let piece: PendingExample[] = [];
  for (const member of members) {
    const candidate = [...piece, member];
    if (piece.length > 0 && groupContent(candidate, budget).length > budget) {
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

/** One chunk carrying a group of tiny sibling examples, named after its first member. */
function groupChunk(members: PendingExample[], scopeId: string, budget: number): BodyChunkResult {
  const [first] = members;
  const last = members[members.length - 1];
  return {
    content: groupContent(members, budget),
    startLine: first.example.startLine,
    endLine: last.example.endLine,
    lineRanges: members.map((m) => ({ start: m.example.startLine, end: m.example.endLine })),
    chunkType: "test",
    symbolId: first.symbolId,
    name: first.example.name,
    parentSymbolId: scopeId,
    parentType: TEST_SCOPE_PARENT_TYPE,
    memberSymbolIds: members.map((m) => m.symbolId),
  };
}

/**
 * A scope's own setup and other lines, waiting to be packed. Kept whatever its
 * size when an example below depends on it — hydration renders it into those
 * examples; a leaf with setup and nothing else must clear the minimum like any
 * other chunk.
 */
function pendingScopeSetup(scope: TestScope, scopeId: string): PendingSetup | undefined {
  const own: TestScopeLine[] = [...scope.setupLines, ...scope.otherLines];
  if (own.length === 0) return undefined;
  const content = own
    .map((l) => l.text)
    .join("\n")
    .trim();
  if (content.length < MIN_TEST_CHUNK_CONTENT && !hasExamples(scope)) return undefined;
  const lines = own.map((l) => l.sourceLine);
  return {
    scope,
    scopeId,
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
 * Named after the first member; `test` when its member runs shared examples
 * (such a scope is never packed with others), else `test_setup`. Per member,
 * aligned: its scope's span (what an example's start line is matched
 * against), its row count in `content` (what lets hydration render one member
 * alone), and — on a pack of several — its id and own line range.
 */
function setupChunk(members: PendingSetup[], topLevelName: string): BodyChunkResult {
  const [first] = members;
  const packed = members.length > 1;
  return {
    content: members.map((m) => m.content).join("\n"),
    startLine: Math.min(...members.map((m) => m.startLine)),
    endLine: Math.max(...members.map((m) => m.endLine)),
    chunkType: first.delegates ? "test" : "test_setup",
    symbolId: first.scopeId,
    name: first.scope.name,
    parentSymbolId: topLevelName,
    ...(packed ? { lineRanges: members.map((m) => ({ start: m.startLine, end: m.endLine })) } : {}),
    scopeLineRanges: members.map((m) => ({ start: m.scope.startLine, end: m.scope.endLine })),
    memberRowCounts: members.map((m) => m.content.split("\n").length),
    ...(packed ? { memberSymbolIds: members.map((m) => m.scopeId) } : {}),
  };
}

function hasExamples(scope: TestScope): boolean {
  return scope.examples.length > 0 || scope.children.some(hasExamples);
}
