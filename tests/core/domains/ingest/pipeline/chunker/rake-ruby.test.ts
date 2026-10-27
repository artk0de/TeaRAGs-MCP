/**
 * `.rake` is Ruby on the ingest side (bd tea-rags-mcp-k0602): the extension
 * routes to the `ruby` language and a Rake task file chunks with the Ruby AST
 * rules. Without it the scanner never offered the file and detectLanguage
 * answered "unknown", so every `lib/tasks/*.rake` stayed invisible to search
 * while grep saw it.
 */
import { describe, expect, it } from "vitest";

import {
  detectLanguage,
  extensionsForLanguages,
} from "../../../../../../src/core/domains/ingest/pipeline/chunker/language-config/index.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

// Bodies long enough to clear the ruby provider's minimum-chunk filter.
const RAKE_TASKS = `
namespace :billing do
  desc "Sync the billing invoices"
  task seed: :environment do
    templates = Template.where(kind: "billing")
    templates.each do |template|
      template.update!(seeded_at: Time.current)
      Rails.logger.info("seeded #{template.id}")
    end
    helper(templates.count)
  end
end

def helper(count)
  message = "seeded #{count} billing invoices"
  Rails.logger.info(message)
  puts message
  message
end
`;

describe("ingest .rake as Ruby (bd tea-rags-mcp-k0602)", () => {
  const chunker = new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );

  it("routes .rake to the ruby language", () => {
    expect(detectLanguage("lib/tasks/billing.rake")).toBe("ruby");
  });

  it("selects .rake under a ruby language scope", () => {
    expect(extensionsForLanguages(["ruby"])).toEqual(expect.arrayContaining([".rb", ".rake"]));
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-k0602 addendum): Rake is its own DSL, so
  // a .rake file no longer chunks as the same source in .rb does — its task is
  // addressed by its Rake name, while its plain Ruby keeps the Ruby symbolIds.
  it("chunks a .rake file with the Ruby AST: a Rake task by its Rake name, a def by its Ruby symbolId", async () => {
    const relPath = "lib/tasks/billing.rake";
    const chunks = await chunker.chunk(RAKE_TASKS, relPath, detectLanguage(relPath));
    const symbolIds = chunks.map((chunk) => chunk.metadata.symbolId);

    expect(symbolIds).toEqual(["billing:seed", "helper"]);
    expect(chunks.every((chunk) => chunk.metadata.language === "ruby")).toBe(true);
  });
});
