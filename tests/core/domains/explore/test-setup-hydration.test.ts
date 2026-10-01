/**
 * TestSetupHydrator — prepends a test example's setup chain, stored once per
 * scope as its own chunk at index time (bd tea-rags-mcp-5xpq4), back into the
 * example when explore returns it. An example inherits every setup chunk whose
 * SCOPE span (`scopeLineRange`) contains its start line, outermost first.
 */

import { describe, expect, it, vi } from "vitest";

import { TEXT_INDEXED_KEYS } from "../../../../src/core/adapters/qdrant/filters/text-indexed-exact.js";
import { KEYWORD_FILTER_INDEX_KEYS } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import { TestSetupHydrator } from "../../../../src/core/domains/explore/test-setup-hydration.js";

const SPEC = "spec/models/user_spec.rb";
const HEADER = "RSpec.describe User do";

function example(symbolId: string, startLine: number, body: string, relativePath = SPEC) {
  return {
    id: symbolId,
    score: 0.9,
    payload: {
      symbolId,
      relativePath,
      chunkType: "test",
      parentType: "test_scope",
      startLine,
      content: `${HEADER}\n${body}`,
    },
  };
}

function setupPoint(
  symbolId: string,
  scope: { start: number; end: number },
  body: string,
  { relativePath = SPEC, startLine = scope.start + 1 } = {},
) {
  return {
    id: `pt-${symbolId}`,
    payload: {
      symbolId,
      relativePath,
      chunkType: "test_setup",
      startLine,
      scopeLineRange: scope,
      content: `${HEADER}\n${body}`,
    },
  };
}

function hydratorReturning(points: { id: string; payload: Record<string, unknown> }[]) {
  const scrollFiltered = vi.fn().mockResolvedValue(points);
  return { hydrator: new TestSetupHydrator({ scrollFiltered }), scrollFiltered };
}

/** Every payload key a filter conditions on, at any depth, with the match kinds used on it. */
function conditionsOf(filter: unknown, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (Array.isArray(filter)) {
    for (const item of filter) conditionsOf(item, out);
  } else if (filter && typeof filter === "object") {
    const node = filter as Record<string, unknown>;
    if (typeof node.key === "string" && node.match && typeof node.match === "object") {
      const kinds = out.get(node.key) ?? new Set<string>();
      for (const kind of Object.keys(node.match)) kinds.add(kind);
      out.set(node.key, kinds);
    }
    for (const value of Object.values(node)) conditionsOf(value, out);
  }
  return out;
}

describe("TestSetupHydrator", () => {
  it("prepends every enclosing scope's setup, outermost first, after the shared container header", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint("User.context 'admin'", { start: 10, end: 20 }, "before { user.update!(admin: true) }"),
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:user) { create(:user) }"),
    ]);
    const hit = example("User.context 'admin'.it 'can invite'", 12, "context 'admin'\n  it 'can invite' do\n  end");

    const [hydrated] = await hydrator.hydrate([hit], "code_x");

    expect(hydrated.payload.content).toBe(
      [
        HEADER,
        "let(:user) { create(:user) }",
        "before { user.update!(admin: true) }",
        "context 'admin'",
        "  it 'can invite' do",
        "  end",
      ].join("\n"),
    );
  });

  it("never leaks a sibling scope's setup into an example", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint("User.context 'as guest'", { start: 2, end: 12 }, "let(:role) { :guest }"),
      setupPoint("User.context 'as admin'", { start: 14, end: 24 }, "let(:role) { :admin }"),
    ]);

    const [guest, admin] = await hydrator.hydrate(
      [
        example("User.context 'as guest'.it 'a'", 5, "it 'a' do\nend"),
        example("User.context 'as admin'.it 'b'", 17, "it 'b' do\nend"),
      ],
      "code_x",
    );

    expect(guest.payload.content).toBe(`${HEADER}\nlet(:role) { :guest }\nit 'a' do\nend`);
    expect(admin.payload.content).toBe(`${HEADER}\nlet(:role) { :admin }\nit 'b' do\nend`);
  });

  it("fetches a whole page's setup in ONE scroll, by file and chunk type only — index-served conditions", async () => {
    const { hydrator, scrollFiltered } = hydratorReturning([
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:user) { create(:user) }"),
    ]);

    const hydrated = await hydrator.hydrate(
      [example("User.it 'a'", 3, "it 'a' do\nend"), example("User.it 'b'", 7, "it 'b' do\nend")],
      "code_x",
    );

    expect(scrollFiltered).toHaveBeenCalledTimes(1);
    const [collection, filter] = scrollFiltered.mock.calls[0];
    expect(collection).toBe("code_x");
    expect(filter).not.toHaveProperty("must_not");
    const conditions = conditionsOf(filter);
    // relativePath is text-indexed: exact match only as the text + value pair.
    expect(conditions.get("relativePath")).toEqual(new Set(["text", "value"]));
    expect(TEXT_INDEXED_KEYS).toContain("relativePath");
    // chunkType is keyword-indexed.
    expect(conditions.get("chunkType")).toEqual(new Set(["any"]));
    expect(KEYWORD_FILTER_INDEX_KEYS).toContain("chunkType");
    expect([...conditions.keys()].sort()).toEqual(["chunkType", "relativePath"]);
    expect(JSON.stringify(filter).match(new RegExp(SPEC.replaceAll(".", "\\."), "g"))).toHaveLength(2); // one file, once
    expect(hydrated.map((r) => r.payload.content)).toEqual([
      `${HEADER}\nlet(:user) { create(:user) }\nit 'a' do\nend`,
      `${HEADER}\nlet(:user) { create(:user) }\nit 'b' do\nend`,
    ]);
  });

  it("matches setup to its own file — the same span in another spec is another scope", async () => {
    const other = "spec/other/user_spec.rb";
    const { hydrator, scrollFiltered } = hydratorReturning([
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:user) { create(:user) }"),
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:user) { build(:user) }", {
        relativePath: other,
      }),
    ]);

    const [hydrated] = await hydrator.hydrate([example("User.it 'a'", 3, "it 'a' do\nend", other)], "code_x");

    expect(hydrated.payload.content).toContain("build(:user)");
    expect(hydrated.payload.content).not.toContain("create(:user)");
    const filter = scrollFiltered.mock.calls[0][1] as { should: unknown[] };
    expect(filter.should).toHaveLength(1);
    expect(JSON.stringify(filter.should[0])).toContain(other);
  });

  it("reassembles a setup chunk split into #partN windows in line order", async () => {
    const scope = { start: 1, end: 400 };
    const { hydrator } = hydratorReturning([
      setupPoint("User.RSpec.describe User#part2", scope, "let(:b) { 2 }", { startLine: 120 }),
      setupPoint("User.RSpec.describe User#part1", scope, "let(:a) { 1 }", { startLine: 2 }),
    ]);

    const [hydrated] = await hydrator.hydrate([example("User.it 'a'", 300, "it 'a' do\nend")], "code_x");

    expect(hydrated.payload.content).toBe(`${HEADER}\nlet(:a) { 1 }\nlet(:b) { 2 }\nit 'a' do\nend`);
  });

  it("hydrates the #partN windows of one oversized example once, on its earliest part on the page", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint("User.RSpec.describe User", { start: 1, end: 400 }, "let(:user) { create(:user) }"),
    ]);
    const part2 = example("User.it 'long'#part2", 60, "  more\nend");
    const part1 = example("User.it 'long'#part1", 10, "it 'long' do\n  first");

    const [second, first] = await hydrator.hydrate([part2, part1], "code_x");

    expect(first.payload.content).toBe(`${HEADER}\nlet(:user) { create(:user) }\nit 'long' do\n  first`);
    expect(second).toBe(part2);
  });

  it("hydrates a grouped tiny-example chunk with its scope's chain", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "subject { build(:user) }"),
    ]);
    const group = example("User.it", 3, "it { is_expected.to be_valid }\nit { is_expected.to be_persisted }");

    const [hydrated] = await hydrator.hydrate([group], "code_x");

    expect(hydrated.payload.content).toBe(
      `${HEADER}\nsubject { build(:user) }\nit { is_expected.to be_valid }\nit { is_expected.to be_persisted }`,
    );
  });

  it("ignores chunks the scroll brings back without a scope span — examples, and pre-5xpq4 setup", async () => {
    const { hydrator } = hydratorReturning([
      { id: "ex", payload: { ...example("User.it 'other'", 5, "it 'other' do\nend").payload } },
      { id: "old", payload: { symbolId: "User.describe", relativePath: SPEC, chunkType: "test_setup", content: "x" } },
    ]);
    const hit = example("User.it 'a'", 3, "it 'a' do\nend");

    const [hydrated] = await hydrator.hydrate([hit], "code_x");

    expect(hydrated).toBe(hit);
  });

  it("fetches nothing for a page without test examples", async () => {
    const { hydrator, scrollFiltered } = hydratorReturning([]);
    const source = { id: 1, score: 1, payload: { symbolId: "User#save", content: "def save; end", startLine: 3 } };
    const setup = setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:a) { 1 }");

    const hydrated = await hydrator.hydrate([source, { ...setup, score: 1 }], "code_x");

    expect(hydrated).toEqual([source, { ...setup, score: 1 }]);
    expect(scrollFiltered).not.toHaveBeenCalled();
  });

  it("does not mutate the result it was handed", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint("User.RSpec.describe User", { start: 1, end: 40 }, "let(:a) { 1 }"),
    ]);
    const hit = example("User.it 'a'", 3, "it 'a' do\nend");

    await hydrator.hydrate([hit], "code_x");

    expect(hit.payload.content).toBe(`${HEADER}\nit 'a' do\nend`);
  });
});
