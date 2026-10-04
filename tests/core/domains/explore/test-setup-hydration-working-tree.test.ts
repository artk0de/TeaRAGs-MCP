/**
 * TestSetupHydrator on a working tree (bd tea-rags-mcp-xi2r9.3): an example a
 * floor strategy took from the tree is hydrated with the TREE's setup of its
 * file — the delta rows — never with the index's setup of the version the tree
 * replaced. Files the tree did not touch keep reading the index.
 */

import { describe, expect, it, vi } from "vitest";

import { TestSetupHydrator } from "../../../../src/core/domains/explore/test-setup-hydration.js";
import { fakeWorkingTreeView } from "./__fixtures__/working-tree-view.js";

const SPEC = "tests/user.test.ts";
const OTHER = "tests/other.test.ts";
const HEADER = 'describe("User", () => {';

function example(symbolId: string, relativePath = SPEC) {
  return {
    id: symbolId,
    score: 1,
    payload: {
      symbolId,
      relativePath,
      chunkType: "test",
      parentType: "test_scope",
      startLine: 5,
      content: `${HEADER}\n  it("works", () => {});`,
    },
  };
}

function setup(id: string, body: string, relativePath = SPEC) {
  return {
    id,
    payload: {
      symbolId: `${id}.setup`,
      relativePath,
      chunkType: "test_setup",
      startLine: 2,
      scopeLineRanges: [{ start: 1, end: 20 }],
      memberRowCounts: [1],
      content: `${HEADER}\n${body}`,
    },
  };
}

describe("TestSetupHydrator working-tree setup source", () => {
  it("hydrates an example of a modified file with the tree's setup, not the index's", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setup("index", "  const user = indexUser();")]);
    const view = fakeWorkingTreeView({
      changed: [SPEC],
      rows: [setup("tree", "  const user = treeUser();"), example("User.works")],
    });

    const [hydrated] = await new TestSetupHydrator({ scrollFiltered }).hydrate([example("User.works")], "c", view);

    const content = String(hydrated.payload.content);
    expect(content).toContain("treeUser()");
    expect(content).not.toContain("indexUser()");
    expect(scrollFiltered).not.toHaveBeenCalled();
  });

  it("hydrates nothing from the index for a touched file whose tree rows carry no setup", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setup("index", "  const user = indexUser();")]);
    const view = fakeWorkingTreeView({ changed: [SPEC], rows: [example("User.works")] });

    const [hydrated] = await new TestSetupHydrator({ scrollFiltered }).hydrate([example("User.works")], "c", view);

    expect(String(hydrated.payload.content)).not.toContain("indexUser()");
  });

  it("keeps reading the index for files the tree did not touch", async () => {
    const scrollFiltered = vi.fn().mockResolvedValue([setup("index", "  const other = indexOther();", OTHER)]);
    const view = fakeWorkingTreeView({ changed: [SPEC], rows: [setup("tree", "  const user = treeUser();")] });

    const [tree, untouched] = await new TestSetupHydrator({ scrollFiltered }).hydrate(
      [example("User.works"), example("Other.works", OTHER)],
      "c",
      view,
    );

    expect(String(tree.payload.content)).toContain("treeUser()");
    expect(String(untouched.payload.content)).toContain("indexOther()");
    expect(JSON.stringify(scrollFiltered.mock.calls[0][1])).not.toContain(SPEC);
  });
});
