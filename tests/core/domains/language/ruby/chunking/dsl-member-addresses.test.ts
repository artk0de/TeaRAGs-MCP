/**
 * Ruby class-level DSL statements are addressable (bd tea-rags-mcp-5ivtb).
 *
 * A Rails model's `enum` / association / `validates` / callback / `scope` rows
 * were body chunks carrying only the container id, so the class outline drew
 * no line for them and the only way to read a large model's DSL was the whole
 * file. Each DSL statement now names itself in its body chunk's
 * `memberSymbolIds`:
 *   - a macro the codegraph expands into methods takes the id of the FIRST
 *     method it declares, composed as the graph composes it — `scope :recent`
 *     → `Owner.recent`, `has_many :chapters` → `Owner#chapters`,
 *     `enum :status, {…}` → `Owner#status`;
 *   - a macro that declares no method is named by its call — the macro and its
 *     first argument, as an RSpec scope is named (`Owner.validates :title`),
 *     a repeat of the same call suffixed `~N`.
 *
 * One multi-line statement stays in ONE body chunk: a continuation row of the
 * statement above a group change is part of that statement, never the head of
 * the next group.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const OWNER = "Library::Book";

const MODEL = [
  "class Library::Book < ApplicationRecord",
  "  STATUSES = %w[draft published].freeze",
  "",
  "  enum :status, { draft: 0, published: 1 }",
  "  enum :format, FORMATS",
  "",
  '  belongs_to :author, class_name: "Library::Author"',
  "",
  '  has_many :chapters, class_name: "Library::Chapter",',
  "    foreign_key: :book_id, dependent: :destroy",
  "",
  "  validates :title, presence: true",
  "  validates :title, length: { maximum: 200 }",
  "",
  "  before_save :normalize_title",
  "",
  "  scope :published, -> { where(status: :published) }",
  "  scope :recent, -> { order(created_at: :desc) }",
  "",
  "  def normalize_title",
  '    self.title = title.to_s.strip.squeeze(" ").presence || "Untitled book draft"',
  "  end",
  "end",
].join("\n");

function scrollRowOf(chunk: CodeChunk, i: number) {
  return {
    id: `chunk-${i}`,
    payload: {
      ...chunk.metadata,
      relativePath: "app/models/library/book.rb",
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    } as Record<string, unknown>,
  };
}

describe("Ruby chunking — class-level DSL statements are addressable (bd tea-rags-mcp-5ivtb)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("names every DSL statement in its body chunk's memberSymbolIds, in line order", async () => {
    const chunks = await chunker.chunk(MODEL, "/repo/app/models/library/book.rb", "ruby");

    const members = chunks
      .filter((c) => c.metadata.chunkType === "block")
      .sort((a, b) => a.startLine - b.startLine)
      .flatMap((c) => c.metadata.memberSymbolIds ?? []);
    expect(members).toEqual([
      `${OWNER}::STATUSES`,
      `${OWNER}#status`,
      `${OWNER}.enum :format`,
      `${OWNER}#author`,
      `${OWNER}#chapters`,
      `${OWNER}.validates :title`,
      `${OWNER}.validates :title~2`,
      `${OWNER}.before_save :normalize_title`,
      `${OWNER}.published`,
      `${OWNER}.recent`,
    ]);
  });

  it("keeps a multi-line association in one body chunk", async () => {
    const chunks = await chunker.chunk(MODEL, "/repo/app/models/library/book.rb", "ruby");

    const holders = chunks.filter((c) =>
      (c.metadata.lineRanges ?? [{ start: c.startLine, end: c.endLine }]).some((r) => r.start <= 10 && r.end >= 10),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0].content).toContain("has_many :chapters");
    expect(holders[0].content).toContain("foreign_key: :book_id");
    expect(chunks.find((c) => c.content.includes("validates :title, presence"))?.content).not.toContain("foreign_key");
  });

  it("lists the DSL members in the class outline and answers a member id with its block body", async () => {
    const chunks = await chunker.chunk(MODEL, "/repo/app/models/library/book.rb", "ruby");
    const rows = chunks.map(scrollRowOf);

    const classRows = rows.filter((r) => r.payload.symbolId === OWNER || r.payload.parentSymbolId === OWNER);
    const [outline] = resolveSymbols(classRows, OWNER);
    const content = String(outline.payload?.content);
    expect(content.indexOf(`${OWNER}#chapters`)).toBeGreaterThan(content.indexOf(`${OWNER}#author`));
    expect(content).toContain(`${OWNER}.validates :title`);
    expect(content).toContain(`${OWNER}.recent`);

    for (const [id, body] of [
      [`${OWNER}#chapters`, "foreign_key: :book_id"],
      [`${OWNER}.validates :title~2`, "length: { maximum: 200 }"],
      [`${OWNER}.recent`, "order(created_at: :desc)"],
    ] as const) {
      const memberRows = rows.filter(
        (r) => Array.isArray(r.payload.memberSymbolIds) && (r.payload.memberSymbolIds as string[]).includes(id),
      );
      const [answer] = resolveSymbols(memberRows, id);
      expect(answer.payload?.content).toContain(body);
    }
  });
});
