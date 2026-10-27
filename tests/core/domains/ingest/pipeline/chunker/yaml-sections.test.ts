/**
 * bd tea-rags-mcp-q1g6s.7 — Rails config YAML is a doc-only language: the
 * `yaml` vertical's section splitter cuts a file along its key paths, and the
 * chunker emits each section as a documentation block whose `headingPath` is
 * the key path (`production > redis`), so `find_symbol(relativePath:)` shows a
 * TOC of `doc:<hash>` ids and a drill returns the section.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { assignNavigationAndDocSymbolId } from "../../../../../../src/core/domains/ingest/pipeline/chunker/chunk-navigation.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX = 1000;

/** A `key:` map with `entries` children, each value ~`width` chars. */
function mapBlock(key: string, entries: number, width = 40, indent = ""): string {
  const rows = Array.from({ length: entries }, (_, i) => `${indent}  ${key}_${i}: "${"v".repeat(width)}"`);
  return [`${indent}${key}:`, ...rows].join("\n");
}

/** A `key:` sequence with `entries` items — no map value, so no second-level split. */
function seqBlock(key: string, entries: number, width = 40): string {
  const rows = Array.from({ length: entries }, (_, i) => `  - "${key}_${i} ${"v".repeat(width)}"`);
  return [`${key}:`, ...rows].join("\n");
}

function paths(chunks: CodeChunk[]): string[][] {
  return chunks.map((c) => (c.metadata.headingPath ?? []).map((h) => h.text));
}

describe("yaml section splitting (TreeSitterChunker, language yaml)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: MAX },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("keeps a file that fits maxChunkSize as one whole-file documentation chunk", async () => {
    const code = "# database\ndefault: &default\n  adapter: postgresql\n  pool: 5\ndevelopment:\n  <<: *default\n";
    const chunks = await chunker.chunk(code, "/repo/config/database.yml", "yaml");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.isDocumentation).toBe(true);
    expect(chunks[0].metadata.headingPath).toEqual([]);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(6);
    expect(chunks[0].content).toContain("adapter: postgresql");
  });

  it("splits an oversized file into one section per top-level key", async () => {
    const code = [mapBlock("development", 8), mapBlock("test", 8), mapBlock("production", 8)].join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/database.yml", "yaml");

    expect(paths(chunks)).toEqual([["development"], ["test"], ["production"]]);
    expect(chunks.map((c) => c.metadata.name)).toEqual(["development", "test", "production"]);
    expect(chunks.every((c) => c.metadata.isDocumentation === true)).toBe(true);
    expect(chunks.every((c) => c.content.length <= MAX)).toBe(true);
    expect(chunks[1].content.startsWith("test:")).toBe(true);
    expect(chunks[1].startLine).toBe(10);
    expect(chunks[1].endLine).toBe(18);
  });

  it("attaches the comment lines directly above a key, and a leading file comment, to that key's section", async () => {
    const code = [
      "# Shared settings for every environment",
      mapBlock("development", 8),
      "# Production reads secrets from ENV",
      mapBlock("production", 8),
      mapBlock("test", 8),
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/database.yml", "yaml");

    expect(paths(chunks)).toEqual([["development"], ["production"], ["test"]]);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].content.startsWith("# Shared settings")).toBe(true);
    expect(chunks[1].startLine).toBe(11);
    expect(chunks[1].content.startsWith("# Production reads secrets from ENV\nproduction:")).toBe(true);
  });

  it("merges consecutive small top-level pairs while the merge fits", async () => {
    const code = ["host: localhost", "port: 6379", mapBlock("development", 8), mapBlock("production", 8)].join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/redis.yml", "yaml");

    expect(chunks).toHaveLength(3);
    expect(chunks[0].metadata.name).toBe("host");
    expect(chunks[0].content).toContain("port: 6379");
    expect(paths(chunks)[0]).toEqual(["host", "port"]);
    expect(paths(chunks).slice(1)).toEqual([["development"], ["production"]]);
  });

  it("splits a top-level map larger than maxChunkSize into second-level sections", async () => {
    const code = [
      "production:",
      mapBlock("redis", 8, 40, "  "),
      mapBlock("database", 8, 40, "  "),
      mapBlock("storage", 8, 40, "  "),
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/settings.yml", "yaml");

    expect(paths(chunks)).toEqual([
      ["production", "redis"],
      ["production", "database"],
      ["production", "storage"],
    ]);
    expect(chunks[0].metadata.headingPath).toEqual([
      { depth: 1, text: "production" },
      { depth: 2, text: "redis" },
    ]);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].content.startsWith("production:\n  redis:")).toBe(true);
    expect(chunks[1].startLine).toBe(11);
    expect(chunks.every((c) => c.content.length <= MAX)).toBe(true);
  });

  it("cuts a still-oversized section into line windows that share its headingPath and doc id", async () => {
    const code = [seqBlock("queues", 60), mapBlock("tail", 8)].join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/sidekiq.yml", "yaml");
    assignNavigationAndDocSymbolId(chunks, "/repo");

    const windows = chunks.filter((c) => c.metadata.headingPath?.[0]?.text === "queues");
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((c) => c.content.length <= MAX)).toBe(true);
    expect(new Set(windows.map((c) => c.metadata.symbolId)).size).toBe(1);
    expect(windows[0].metadata.symbolId).toMatch(/^doc:[0-9a-f]{12}$/);
    expect(windows[0].startLine).toBe(1);
    expect(windows.at(-1)?.endLine).toBe(61);
    expect(paths(chunks).at(-1)).toEqual(["tail"]);
  });

  it("falls back to headingPath-less line windows for invalid YAML without throwing", async () => {
    const code = `${mapBlock("broken", 30)}\n  : : [unclosed\n${mapBlock("more", 30)}`;
    const chunks = await chunker.chunk(code, "/repo/config/broken.yml", "yaml");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.metadata.isDocumentation === true)).toBe(true);
    expect(chunks.every((c) => (c.metadata.headingPath ?? []).length === 0)).toBe(true);
    expect(chunks.every((c) => c.content.length <= MAX)).toBe(true);
  });

  it("falls back to line windows for an oversized non-map root", async () => {
    const code = Array.from({ length: 40 }, (_, i) => `- item_${i}: "${"v".repeat(40)}"`).join("\n");
    const chunks = await chunker.chunk(code, "/repo/config/list.yml", "yaml");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.metadata.isDocumentation === true)).toBe(true);
    expect(chunks.every((c) => (c.metadata.headingPath ?? []).length === 0)).toBe(true);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(40);
  });
});
