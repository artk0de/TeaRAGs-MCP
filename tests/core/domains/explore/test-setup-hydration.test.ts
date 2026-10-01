/**
 * TestSetupHydrator — prepends a test example's setup chain, stored once per
 * scope as its own chunk at index time (bd tea-rags-mcp-5xpq4), back into the
 * example when explore returns it.
 */

import { describe, expect, it, vi } from "vitest";

import { TestSetupHydrator } from "../../../../src/core/domains/explore/test-setup-hydration.js";

const SPEC = "spec/models/user_spec.rb";
const ROOT = "User.RSpec.describe User";
const ADMIN = "User.context 'v1.2 admin'~2";

function example(symbolId: string, content: string, setupScopeIds?: string[], relativePath = SPEC) {
  return {
    id: symbolId,
    score: 0.9,
    payload: {
      symbolId,
      relativePath,
      chunkType: "test",
      parentType: "test_scope",
      content,
      ...(setupScopeIds ? { setupScopeIds } : {}),
    },
  };
}

function setupPoint(symbolId: string, content: string, relativePath = SPEC, parentSymbolId = "User") {
  return { id: `pt-${symbolId}`, payload: { symbolId, parentSymbolId, relativePath, content, startLine: 2 } };
}

function hydratorReturning(points: { id: string; payload: Record<string, unknown> }[]) {
  const scrollFiltered = vi.fn().mockResolvedValue(points);
  return { hydrator: new TestSetupHydrator({ scrollFiltered }), scrollFiltered };
}

describe("TestSetupHydrator", () => {
  it("prepends the setup chain outermost first, after the container header the chunks share", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint(ADMIN, "RSpec.describe User do\nbefore { user.update!(admin: true) }"),
      setupPoint(ROOT, "RSpec.describe User do\nlet(:user) { create(:user) }"),
    ]);
    const hit = example(
      `${ADMIN}.it 'can invite'`,
      "RSpec.describe User do\ncontext 'v1.2 admin'\n  it 'can invite' do\n  end",
      [ROOT, ADMIN],
    );

    const [hydrated] = await hydrator.hydrate([hit], "code_x");

    expect(hydrated.payload.content).toBe(
      [
        "RSpec.describe User do",
        "let(:user) { create(:user) }",
        "before { user.update!(admin: true) }",
        "context 'v1.2 admin'",
        "  it 'can invite' do",
        "  end",
      ].join("\n"),
    );
  });

  it("fetches the setup of a whole page in ONE scroll, each scope once", async () => {
    const { hydrator, scrollFiltered } = hydratorReturning([
      setupPoint(ROOT, "RSpec.describe User do\nlet(:user) { create(:user) }"),
    ]);
    const hits = [
      example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT]),
      example(`${ROOT}.it 'b'`, "RSpec.describe User do\nit 'b' do\nend", [ROOT]),
    ];

    const hydrated = await hydrator.hydrate(hits, "code_x");

    expect(scrollFiltered).toHaveBeenCalledTimes(1);
    const [collection, filter] = scrollFiltered.mock.calls[0];
    expect(collection).toBe("code_x");
    expect(JSON.stringify(filter).match(/User\.RSpec\.describe User"/g)).toHaveLength(2); // symbolId + parentSymbolId arm, once
    expect(hydrated.map((r) => r.payload.content)).toEqual([
      "RSpec.describe User do\nlet(:user) { create(:user) }\nit 'a' do\nend",
      "RSpec.describe User do\nlet(:user) { create(:user) }\nit 'b' do\nend",
    ]);
  });

  it("matches a setup chunk to its file — the same scope id in another spec is another scope", async () => {
    const { hydrator, scrollFiltered } = hydratorReturning([
      setupPoint(ROOT, "RSpec.describe User do\nlet(:user) { create(:user) }"),
      setupPoint(ROOT, "RSpec.describe User do\nlet(:user) { build(:user) }", "spec/other/user_spec.rb"),
    ]);

    const [hydrated] = await hydrator.hydrate(
      [example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT], "spec/other/user_spec.rb")],
      "code_x",
    );

    expect(hydrated.payload.content).toContain("build(:user)");
    expect(hydrated.payload.content).not.toContain("create(:user)");
    const filter = scrollFiltered.mock.calls[0][1] as { should: { must: unknown[] }[] };
    expect(filter.should).toHaveLength(1);
    expect(JSON.stringify(filter.should[0].must)).toContain("spec/other/user_spec.rb");
  });

  it("reassembles a setup chunk split into #partN windows in part order", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint(`${ROOT}#part2`, "RSpec.describe User do\nlet(:b) { 2 }", SPEC, ROOT),
      setupPoint(`${ROOT}#part1`, "RSpec.describe User do\nlet(:a) { 1 }", SPEC, ROOT),
    ]);

    const [hydrated] = await hydrator.hydrate(
      [example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT])],
      "code_x",
    );

    expect(hydrated.payload.content).toBe("RSpec.describe User do\nlet(:a) { 1 }\nlet(:b) { 2 }\nit 'a' do\nend");
  });

  it("ignores an example chunk the parentSymbolId arm brings back with the scope's setup", async () => {
    const { hydrator } = hydratorReturning([
      setupPoint(ROOT, "RSpec.describe User do\nlet(:user) { create(:user) }"),
      setupPoint(`${ROOT}.it 'other'`, "RSpec.describe User do\nit 'other' do\nend", SPEC, ROOT),
    ]);

    const [hydrated] = await hydrator.hydrate(
      [example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT])],
      "code_x",
    );

    expect(hydrated.payload.content).toBe("RSpec.describe User do\nlet(:user) { create(:user) }\nit 'a' do\nend");
  });

  it("passes chunks without setupScopeIds through untouched and fetches nothing for them (old index)", async () => {
    const { hydrator, scrollFiltered } = hydratorReturning([]);
    const legacy = example("User.it 'a'", "let(:user) { create(:user) }\nit 'a' do\nend");
    const source = { id: 1, score: 1, payload: { symbolId: "User#save", content: "def save; end" } };

    const hydrated = await hydrator.hydrate([legacy, source], "code_x");

    expect(hydrated).toEqual([legacy, source]);
    expect(scrollFiltered).not.toHaveBeenCalled();
  });

  it("leaves an example unchanged when its setup chunks are not in the index", async () => {
    const { hydrator } = hydratorReturning([]);
    const hit = example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT]);

    const [hydrated] = await hydrator.hydrate([hit], "code_x");

    expect(hydrated).toBe(hit);
  });

  it("does not mutate the result it was handed", async () => {
    const { hydrator } = hydratorReturning([setupPoint(ROOT, "RSpec.describe User do\nlet(:a) { 1 }")]);
    const hit = example(`${ROOT}.it 'a'`, "RSpec.describe User do\nit 'a' do\nend", [ROOT]);

    await hydrator.hydrate([hit], "code_x");

    expect(hit.payload.content).toBe("RSpec.describe User do\nit 'a' do\nend");
  });
});
