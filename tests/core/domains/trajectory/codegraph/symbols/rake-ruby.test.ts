/**
 * `.rake` is walked by the Ruby codegraph walker (bd tea-rags-mcp-k0602): the
 * extension has a `CODEGRAPH_LANGUAGES` row with the ruby grammar and the `::`
 * scope separator, so pass-1 discovers and walks a Rake task file exactly as it
 * walks a `.rb` file. Ingest lists `.rake` in `LANGUAGE_MAP` /
 * `DEFAULT_CODE_EXTENSIONS` — the three tables move together, or a file has
 * chunks and no graph node, or the reverse.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  CODEGRAPH_LANGUAGE_BY_EXTENSION,
  CODEGRAPH_LANGUAGES,
  CodegraphFileExtractor,
  loadCodegraphGrammarSync,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";

const RAKE_TASKS = `namespace :billing do
  task seed: :environment do
    helper(Template.count)
  end
end

module Seeds
  def self.run
    helper(1)
  end
end

def helper(count)
  puts count
end
`;

describe("codegraph walks .rake as Ruby (bd tea-rags-mcp-k0602)", () => {
  it("has a ruby row with the `::` scope separator", () => {
    expect(CODEGRAPH_LANGUAGES[".rake"]).toEqual(CODEGRAPH_LANGUAGES[".rb"]);
    expect(CODEGRAPH_LANGUAGES[".rake"]?.scopeSeparator).toBe("::");
    expect(CODEGRAPH_LANGUAGE_BY_EXTENSION[".rake"]).toBe("ruby");
  });

  it("discovers and admits a lib/tasks .rake file for extraction", () => {
    const extractor = new CodegraphFileExtractor({ exclusionFilter: { ignores: () => false } } as never);
    const repo = mkdtempSync(join(tmpdir(), "k0602-cg-rake-"));
    try {
      mkdirSync(join(repo, "lib", "tasks"), { recursive: true });
      writeFileSync(join(repo, "lib", "tasks", "billing.rake"), RAKE_TASKS);

      expect(extractor.isExtractable("lib/tasks/billing.rake")).toBe(true);
      expect(extractor.discover(repo)).toEqual(["lib/tasks/billing.rake"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("walks the .rake file with the Ruby walker and composes Ruby symbolIds", () => {
    const factory = new LanguageFactory();
    const row = CODEGRAPH_LANGUAGES[".rake"];
    if (!row) throw new Error("no .rake codegraph row");
    const parser = new Parser();
    parser.setLanguage(loadCodegraphGrammarSync(factory, ".rake"));
    const tree = { rootNode: parser.parse(RAKE_TASKS).rootNode };
    const { walker } = factory.create(row.language);
    if (!walker) throw new Error("ruby provider has no walker");
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      row.scopeSeparator,
      row.disambiguateOverloads ?? false,
      new DefaultSymbolIdComposer(),
    );
    const extraction = walker.walk({
      tree,
      code: RAKE_TASKS,
      relPath: "lib/tasks/billing.rake",
      language: row.language,
      chunks,
    });

    const symbolIds = extraction.chunks.map((chunk) => chunk.symbolId);
    expect(symbolIds).toEqual(expect.arrayContaining(["helper", "Seeds.run"]));
    const task = extraction.chunks.find((chunk) => chunk.symbolId === "Seeds.run");
    expect(task?.calls.map((call) => call.member)).toContain("helper");
  });
});
