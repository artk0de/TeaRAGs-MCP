import { describe, expect, it } from "vitest";

import { createWorkingTreeDeltaAdmission } from "../../src/bootstrap/factory.js";

/**
 * `createWorkingTreeDeltaAdmission`: a changed file enters the working-tree
 * delta only when ingest would chunk it with an AST-tier `full` chunker —
 * tree-sitter languages and Markdown. CharacterChunker files (config, data,
 * unknown extensions) are served from the index.
 */
describe("createWorkingTreeDeltaAdmission", () => {
  const admits = createWorkingTreeDeltaAdmission();

  it.each(["src/a.ts", "src/view.tsx", "lib/b.js", "app/c.py", "cmd/d.go", "lib/e.rb", "Sources/f.swift"])(
    "admits the AST-chunked source file %s",
    (path) => {
      expect(admits(path)).toBe(true);
    },
  );

  it.each(["README.md", "scripts/run.sh"])("admits %s, whose chunker is AST-tier full", (path) => {
    expect(admits(path)).toBe(true);
  });

  it.each([
    "package.json",
    "tsconfig.jsonc",
    "config/app.yaml",
    ".github/ci.yml",
    "db/schema.sql",
    "Cargo.toml",
    "pom.xml",
    "assets/logo.bin",
    "Makefile",
  ])("serves %s from the index", (path) => {
    expect(admits(path)).toBe(false);
  });
});
