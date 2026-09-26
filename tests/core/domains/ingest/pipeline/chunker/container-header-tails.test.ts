/**
 * Every `#partN` tail names its container (bd tea-rags-mcp-j4jrn).
 *
 * Follow-up of 4i6ab / jgb5a, which put the container header on every part of
 * a split MEMBER. Four other paths still produced tails that named nothing:
 *
 *   1. a Ruby class-body group was sized to the whole `maxChunkSize`, so the
 *      header pushed it over and the `enforceMaxChunkSize` post-pass line-cut
 *      it — `#part2` carried no `class` row;
 *   2. a container remainder's `#part2+` carried only the hierarchy prefix,
 *      which for a top-level container is nothing;
 *   3. an RSpec setup-only chunk overflowed under the engine's header prefix and
 *      was line-cut by the post-pass without it;
 *   4. a container opening with an attribute row (`@NSApplicationMain`) took
 *      that row as its header, so no member chunk named the class.
 *
 * All through the real `TreeSitterChunker`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX_CHUNK_SIZE = 1000;

/** Chunks of `base` itself (the unsplit chunk or its `#partN`), not its members. */
function chunksOf(chunks: CodeChunk[], base: string): CodeChunk[] {
  return chunks.filter((c) => (c.metadata.symbolId ?? "").replace(/#part\d+$/, "") === base);
}

/** Chunks among `of` that are over budget or do not carry `header` as a row. */
function offenders(of: CodeChunk[], header: string): string[] {
  return of
    .filter((c) => c.content.length > MAX_CHUNK_SIZE || !c.content.split("\n").some((l) => l.trim() === header))
    .map((c) => `${c.metadata.symbolId} ${c.startLine}-${c.endLine} (${c.content.length}):\n${c.content}`);
}

describe("TreeSitterChunker — every #partN tail names its container (bd tea-rags-mcp-j4jrn)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: MAX_CHUNK_SIZE },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("ruby: a class-body group sized near the cap is budgeted for its header, never line-cut", async () => {
    // 99-char rows: a 1000-char group holds exactly ten of them, leaving no room
    // for the class header unless the grouper reserves it.
    const constants = Array.from({ length: 24 }, (_, i) => {
      const id = String(i).padStart(2, "0");
      return `  HELPER_CONSTANT_${id} = "${`value number ${id} for helpers`.padEnd(67, ".")}".freeze`;
    }).join("\n");
    const code = `class HelpersTest < Minitest::Test
${constants}

  def test_helpers_are_available_in_the_template
    assert_equal "value number 0 for helpers", HELPER_CONSTANT_00
  end
end
`;
    const chunks = await chunker.chunk(code, "test/helpers_test.rb", "ruby");
    const own = chunksOf(chunks, "HelpersTest");

    expect(own.length).toBeGreaterThan(1);
    expect(offenders(own, "class HelpersTest < Minitest::Test")).toEqual([]);
    // Sized at the source: the groups are whole body chunks, not post-pass parts.
    expect(own.filter((c) => /#part\d+$/.test(c.metadata.symbolId ?? ""))).toEqual([]);
  });

  it("python: every part of an oversized container remainder carries the container header", async () => {
    const attributes = Array.from(
      { length: 40 },
      (_, i) => `    setting_number_${String(i).padStart(2, "0")} = "default value ${i}"`,
    ).join("\n");
    const code = `class Settings:
${attributes}

    def load_from_environment(self, prefix="APP_"):
        return {key: value for key, value in os.environ.items() if key.startswith(prefix)}
`;
    const chunks = await chunker.chunk(code, "src/settings.py", "python");
    const own = chunksOf(chunks, "Settings");

    expect(own.length).toBeGreaterThan(1);
    expect(offenders(own, "class Settings:")).toEqual([]);
  });

  it("ruby rspec: every part of an oversized setup-only chunk carries the describe header", async () => {
    const lets = Array.from(
      { length: 24 },
      (_, i) => `      let(:allowed_host_${String(i).padStart(2, "0")}) { "host-${i}.example.org" }`,
    ).join("\n");
    const code = `RSpec.describe Rack::Protection::HostAuthorization do
  context "with a permitted host list" do
${lets}
  end

  it "allows the request through for a permitted host" do
    expect(response.status).to eq(200)
  end
end
`;
    const chunks = await chunker.chunk(code, "spec/host_authorization_spec.rb", "ruby");
    const setup = chunks.filter((c) => c.content.includes("let(:allowed_host_"));

    expect(setup.length).toBeGreaterThan(1);
    expect(offenders(setup, "RSpec.describe Rack::Protection::HostAuthorization do")).toEqual([]);
  });

  it("swift: a container opening with an attribute row names the class, not the attribute", async () => {
    const code = `@NSApplicationMain
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = MainWindowController(windowNibName: "MainWindow")
        controller.showWindow(self)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return UserDefaults.standard.bool(forKey: "QuitWhenLastWindowCloses")
    }
}
`;
    const chunks = await chunker.chunk(code, "Sources/AppDelegate.swift", "swift");
    const members = chunks.filter((c) => (c.metadata.symbolId ?? "").startsWith("AppDelegate#"));

    expect(members.length).toBeGreaterThan(0);
    expect(offenders(members, "class AppDelegate: NSObject, NSApplicationDelegate {")).toEqual([]);
  });
});
