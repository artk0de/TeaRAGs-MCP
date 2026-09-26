/**
 * The naming review's in-memory extraction (bd tea-rags-mcp-fdef2) walks a
 * changed file with the same run-level context the index-time extraction hands
 * every walk: the working tree's Gemfile and its declared dependencies — so a
 * Ruby DSL vocabulary is gated the way the indexed rows were.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNamingReviewExtractor } from "../../../../../src/core/api/internal/ops/naming-review-extraction.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import type * as CodegraphTrajectory from "../../../../../src/core/domains/trajectory/codegraph/index.js";

const { extractFileInMemory } = vi.hoisted(() => ({ extractFileInMemory: vi.fn() }));

vi.mock("../../../../../src/core/domains/trajectory/codegraph/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CodegraphTrajectory>();
  extractFileInMemory.mockImplementation(actual.extractFileInMemory);
  return { ...actual, extractFileInMemory };
});

describe("createNamingReviewExtractor", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "naming-review-extraction-"));
    extractFileInMemory.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hands the walk the working tree's Gemfile and declared dependencies, read once per review", () => {
    // Ruby's vocabulary gate reads the raw Gemfile; the manifest walk (here Python's requirements) the rest.
    const gemfile = 'source "https://rubygems.org"\ngem "rails"\n';
    writeFileSync(join(root, "Gemfile"), gemfile);
    writeFileSync(join(root, "requirements.txt"), "django==5.0\n");
    const extract = createNamingReviewExtractor(new LanguageFactory({})).forWorkingTree(root);

    const first = extract("app/models/doc.rb", "class Doc\n  def total\n    1\n  end\nend\n");
    extract("app/models/other.rb", "class Other\nend\n");

    expect(first?.language).toBe("ruby");
    expect(first?.types.map((t) => t.typeId)).toContain("Doc");
    const contexts = extractFileInMemory.mock.calls.map((call) => call[3] as Record<string, unknown>);
    expect(contexts[0].gemfileContent).toBe(gemfile);
    expect(contexts[0].declaredDependencies).toBeInstanceOf(Set);
    expect((contexts[0].declaredDependencies as Set<string>).has("django")).toBe(true);
    expect(contexts[1]).toBe(contexts[0]);
  });

  it("a working tree with no manifest walks with every vocabulary active", () => {
    const extract = createNamingReviewExtractor(new LanguageFactory({})).forWorkingTree(root);
    extract("src/a.ts", "export class A {}\n");
    const context = extractFileInMemory.mock.calls[0][3] as Record<string, unknown>;
    expect(context.gemfileContent).toBeUndefined();
    expect(context.declaredDependencies).toBeUndefined();
  });

  it("returns the chunks' line ranges, so the review can quote a declaration's enclosing code", () => {
    const extract = createNamingReviewExtractor(new LanguageFactory({})).forWorkingTree(root);
    const declarations = extract("src/a.ts", "export class A {\n  run(): void {\n    go();\n  }\n}\n");
    expect(declarations?.chunks.length).toBeGreaterThan(0);
    for (const chunk of declarations?.chunks ?? []) expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
  });

  it("a path no codegraph language walks → null", () => {
    expect(createNamingReviewExtractor(new LanguageFactory({})).forWorkingTree(root)("notes.md", "# x\n")).toBeNull();
  });
});
