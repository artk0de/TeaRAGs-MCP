import { describe, expect, it } from "vitest";

import { collectionPathFields as codegraphFields } from "../../../../src/core/api/tools/codegraph.js";
import { IndexCodebaseSchema, projectField, WORKING_TREE_PATH_HINT } from "../../../../src/core/api/tools/schemas.js";

describe("addressing param descriptions (project = index, path = tree)", () => {
  const projectText = "Index alias — pass every call. Alone → registered checkout. Priority: collection>project>path.";

  it("projectField describes the index and says to pass it always", () => {
    expect(projectField().description).toBe(projectText);
  });

  it("WORKING_TREE_PATH_HINT describes the tree, passed with project", () => {
    expect(WORKING_TREE_PATH_HINT).toBe(
      "Working tree: your cwd (checkout / worktree). Pass WITH project; needed for worktrees.",
    );
  });

  it("codegraph tools reuse the shared project/path text", () => {
    const fields = codegraphFields();
    expect(fields.project.description).toBe(projectText);
    expect(fields.path.description).toBe(WORKING_TREE_PATH_HINT);
    expect(fields.collection.description).toMatch(/prefer project \+ path\.$/);
  });

  it("index_codebase project/path describe (re)index vs first-time registration", () => {
    expect(IndexCodebaseSchema.project.description).toBe("Registered alias to (re)index — the normal case.");
    expect(IndexCodebaseSchema.path.description).toBe(
      "First-time registration of a NEW codebase root only. Never to reindex an alias (a worktree seeds a separate project).",
    );
  });
});
