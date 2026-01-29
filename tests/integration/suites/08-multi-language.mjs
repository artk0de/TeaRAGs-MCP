/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { section, assert, log, skip, sleep, createTestFile, hashContent, randomUUID, resources } from "../helpers.mjs";
import { CodeIndexer } from "../../../build/code/indexer.js";
import { TEST_DIR, getIndexerConfig } from "../config.mjs";

export async function testMultiLanguage(qdrant, embeddings) {
  section("8. Multi-Language Support");

  const langTestDir = join(TEST_DIR, "lang_test");
  await fs.mkdir(langTestDir, { recursive: true });

  // TypeScript
  await createTestFile(langTestDir, "app.ts", `
export class TypeScriptClass {
  method(): string { return "ts"; }
}
`);

  // JavaScript
  await createTestFile(langTestDir, "util.js", `
function javascriptFunction() {
  return { type: "js" };
}
module.exports = { javascriptFunction };
`);

  // Python
  await createTestFile(langTestDir, "script.py", `
class PythonClass:
    def method(self):
        return "python"
`);

  // Ruby
  await createTestFile(langTestDir, "service.rb", `
class RubyService
  def initialize(config)
    @config = config
  end

  def process(data)
    data.map { |item| transform(item) }
  rescue StandardError => e
    handle_error(e)
  end

  def self.create(options)
    new(options)
  end
end
`);

  const indexer = new CodeIndexer(qdrant, embeddings, getIndexerConfig({
    supportedExtensions: [".ts", ".js", ".py", ".rb"],
  }));

  resources.trackIndexedPath(langTestDir);
  const stats = await indexer.indexCodebase(langTestDir, { forceReindex: true });
  assert(stats.filesIndexed === 4, `All language files indexed: ${stats.filesIndexed}`);

  // Search in each language
  const tsResults = await indexer.searchCode(langTestDir, "TypeScriptClass");
  assert(tsResults.length > 0, `TypeScript searchable: ${tsResults.length}`);

  const jsResults = await indexer.searchCode(langTestDir, "javascriptFunction");
  assert(jsResults.length > 0, `JavaScript searchable: ${jsResults.length}`);

  const pyResults = await indexer.searchCode(langTestDir, "PythonClass");
  assert(pyResults.length > 0, `Python searchable: ${pyResults.length}`);

  const rbResults = await indexer.searchCode(langTestDir, "RubyService process");
  assert(rbResults.length > 0, `Ruby searchable: ${rbResults.length}`);
}
