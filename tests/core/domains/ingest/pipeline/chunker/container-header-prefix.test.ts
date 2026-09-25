/**
 * The container header a chunk carries — once, and on every member part.
 *
 * bd tea-rags-mcp-4i6ab — a container's own-rows chunk (a hook's body chunk or
 * the engine's remainder) must name its container exactly ONCE. The hook
 * already opened the body chunk with the container's first row verbatim
 * (`export class X extends Y {`); the engine then prepended its own
 * `class X extends Y {` on top, so every such chunk read the header twice.
 *
 * bd tea-rags-mcp-jgb5a — every `#partN` of a split MEMBER opens with the
 * container hierarchy prefix, exactly like the unsplit member chunk does, and
 * still fits the budget: the prefix comes out of each part's capacity. Layout
 * of a part: hierarchy prefix → [leading JSDoc, #part1 only] → the splitter's
 * signature/context prefix → the part's own rows.
 *
 * All through the real `TreeSitterChunker`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX_CHUNK_SIZE = 1000;

/** A header row with its `export` keyword dropped — the form the engine prefixes. */
function normalizeHeader(line: string): string {
  return line.trim().replace(/^export\s+(default\s+)?/, "");
}

/** How many lines of `chunk` are the container header, `export` or not. */
function headerCount(chunk: CodeChunk, header: string): number {
  return chunk.content.split("\n").filter((line) => normalizeHeader(line) === header).length;
}

function expectHeaderAtMostOnceEverywhere(chunks: CodeChunk[], header: string): void {
  const doubled = chunks
    .filter((c) => headerCount(c, header) > 1)
    .map((c) => `${c.metadata.symbolId} ${c.startLine}-${c.endLine}:\n${c.content}`);
  expect(doubled).toEqual([]);
}

function partsOf(chunks: CodeChunk[], base: string): CodeChunk[] {
  return chunks.filter((c) =>
    new RegExp(`^${base.replace(/[.#]/g, "\\$&")}#part\\d+$`).test(c.metadata.symbolId ?? ""),
  );
}

describe("TreeSitterChunker — container header on own-rows chunks and member parts", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: MAX_CHUNK_SIZE },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  describe("the container header appears once (bd tea-rags-mcp-4i6ab)", () => {
    it("typescript: an exported class's field chunk names the class once", async () => {
      const code = `/**
 * Raised when the daemon build no longer matches the client build.
 */
export class CodegraphClientStaleBuildError extends InfraError {
  readonly missingOps: readonly string[];

  constructor(skew: { socketPath: string; missingOps: readonly string[] }, cause?: Error) {
    super({ code: "INFRA_CODEGRAPH_CLIENT_STALE_BUILD", message: \`stale \${skew.socketPath}\`, cause });
    this.missingOps = skew.missingOps;
  }
}
`;
      const chunks = await chunker.chunk(code, "src/errors.ts", "typescript");
      const header = "class CodegraphClientStaleBuildError extends InfraError {";

      expectHeaderAtMostOnceEverywhere(chunks, header);
      const own = chunks.find((c) => c.content.includes("readonly missingOps"));
      expect(own).toBeDefined();
      expect(headerCount(own!, header)).toBe(1);
      expect(own!.content.split("\n")[0]).toBe(`export ${header}`);
    });

    it("python: a class remainder carries its header row once", async () => {
      const code = `class Config(dict):
    default_timeout_seconds = 30
    retry_attempts_before_giving_up = 3

    def __init__(self, root_path, defaults=None):
        super().__init__(defaults or {})
        self.root_path = root_path

    def from_envvar(self, variable_name, silent=False):
        rv = os.environ.get(variable_name)
        return self.from_pyfile(rv, silent=silent)
`;
      const chunks = await chunker.chunk(code, "src/config.py", "python");
      const header = "class Config(dict):";

      expectHeaderAtMostOnceEverywhere(chunks, header);
      const own = chunks.find((c) => c.metadata.symbolId === "Config");
      expect(own).toBeDefined();
      expect(headerCount(own!, header)).toBe(1);
      expect(own!.content).toContain("default_timeout_seconds = 30");
    });

    it("ruby: a class body chunk names the class once", async () => {
      const code = `class Request < Rack::Request
  HEADER_PARAM = /\\s*[\\w.]+=(?:[\\w.]+|"(?:[^"\\\\]|\\\\.)*")?\\s*/.freeze
  HEADER_VALUE_WITH_PARAMS = /(?:(?:\\w+|\\*)\\/(?:\\w+(?:\\.|-|\\+)?|\\*)*)\\s*(?:;#{HEADER_PARAM})*/.freeze

  def accept
    @env['sinatra.accept'] ||= parse_accept_header(@env['HTTP_ACCEPT'])
  end

  def preferred_type(*types)
    return accept.first if types.empty?
    types.flatten!
  end
end
`;
      const chunks = await chunker.chunk(code, "lib/request.rb", "ruby");
      const header = "class Request < Rack::Request";

      expectHeaderAtMostOnceEverywhere(chunks, header);
      const own = chunks.find((c) => c.content.includes("HEADER_PARAM = "));
      expect(own).toBeDefined();
      expect(headerCount(own!, header)).toBe(1);
    });

    it("typescript: a const-object namespace remainder carries `export const X = {` once, verbatim", async () => {
      const code = `export const typescriptCommentCaptureHook: ChunkingHook = {
  name: "typescript-comment-capture",
  priority: HOOK_PRIORITY_COMMENT_CAPTURE,

  filterNode(node: AstNode, code: string): boolean | undefined {
    if (node.type !== "comment") return undefined;
    return code.substring(node.startIndex, node.endIndex).startsWith("/**");
  },

  process(ctx: HookContext): void {
    for (const child of ctx.validChildren) ctx.excludedRows.add(child.startPosition.row);
    ctx.methodPrefixes.set(0, "captured comment prefix for the first member");
  },
};
`;
      const chunks = await chunker.chunk(code, "src/comment-capture.ts", "typescript");
      const namespace = chunks.find((c) => c.metadata.symbolId === "typescriptCommentCaptureHook");

      expect(namespace).toBeDefined();
      const headerRows = namespace!.content.split("\n").filter((l) => l.includes("typescriptCommentCaptureHook"));
      expect(headerRows).toEqual(["export const typescriptCommentCaptureHook: ChunkingHook = {"]);
    });
  });

  describe("every part of a split member carries the container prefix (bd tea-rags-mcp-jgb5a)", () => {
    const statements = Array.from(
      { length: 30 },
      (_, i) => `    const attempt${i} = observedDaemonFingerprints[${i}] ?? clientFingerprint;`,
    ).join("\n");
    const code = `export class CodegraphDaemonStaleBuildError extends InfraError {
  /**
   * Builds the refusal from every fingerprint the restart attempts observed.
   */
  constructor(
    socketPath: string,
    clientFingerprint: string,
    observedDaemonFingerprints: readonly string[],
  ) {
${statements}
    super({ code: "INFRA_CODEGRAPH_DAEMON_STALE_BUILD", message: socketPath });
  }
}
`;
    const header = "class CodegraphDaemonStaleBuildError extends InfraError {";

    it("typescript: each #partN opens with the class header, fits the budget, and #part1 keeps its JSDoc next", async () => {
      const chunks = await chunker.chunk(code, "src/errors.ts", "typescript");
      const parts = partsOf(chunks, "CodegraphDaemonStaleBuildError#constructor");

      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.content.split("\n")[0], `${part.metadata.symbolId} opens with its class`).toBe(header);
        expect(part.content.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
      }
      // hierarchy prefix → leading JSDoc → the member's own first row
      expect(parts[0].content.split("\n").slice(1, 3)).toEqual([
        "/**",
        "   * Builds the refusal from every fingerprint the restart attempts observed.",
      ]);
      // later parts: hierarchy prefix → the splitter's signature context
      for (const part of parts.slice(1)) expect(part.content.split("\n")[1]).toBe("constructor(");
    });

    it("typescript: a member that fits alone but not under its class header and JSDoc is split the same way", async () => {
      const doc = Array.from(
        { length: 4 },
        (_, i) => `   * Paragraph ${i}: why the staging copy is renamed over the target only at the end.`,
      ).join("\n");
      const body = Array.from({ length: 14 }, (_, i) => `    await copyFile(source${i}, staging${i});`).join("\n");
      const member = `  async cloneDatabase(sourceCollection: string, targetCollection: string): Promise<void> {
${body}
    await rename(staging, targetCollection);
  }`;
      const fits = `export class CodegraphDbFiles {
  /**
${doc}
   */
${member}
}
`;
      // The member alone fits the budget; with the class header and its JSDoc it does not.
      expect(member.trim().length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
      expect(`class CodegraphDbFiles {\n  /**\n${doc}\n   */\n${member.trim()}`.length).toBeGreaterThan(MAX_CHUNK_SIZE);
      const chunks = await chunker.chunk(fits, "src/codegraph-db-files.ts", "typescript");
      const parts = partsOf(chunks, "CodegraphDbFiles#cloneDatabase");

      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.content.split("\n")[0]).toBe("class CodegraphDbFiles {");
        expect(part.content.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
      }
      for (const part of parts.slice(1)) {
        expect(part.content.split("\n")[1]).toBe(
          "async cloneDatabase(sourceCollection: string, targetCollection: string): Promise<void> {",
        );
      }
    });

    it("typescript: no chunk of the class repeats its header", async () => {
      const chunks = await chunker.chunk(code, "src/errors.ts", "typescript");
      expectHeaderAtMostOnceEverywhere(chunks, header);
    });

    it("typescript: a top-level split function gains no prefix", async () => {
      const fn = `export function reportStaleBuild(observedDaemonFingerprints: readonly string[], clientFingerprint: string) {
${statements}
  return observedDaemonFingerprints.length;
}
`;
      const chunks = await chunker.chunk(fn, "src/report.ts", "typescript");
      const parts = partsOf(chunks, "reportStaleBuild");
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0].content.split("\n")[0]).toBe(
        "function reportStaleBuild(observedDaemonFingerprints: readonly string[], clientFingerprint: string) {",
      );
    });
  });
});
