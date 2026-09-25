/**
 * bd tea-rags-mcp-deoki — a container whose children are extracted keeps every
 * one of its own rows in SOME chunk.
 *
 * Before the fix the engine emitted the extracted children and, for the
 * container itself, either nothing (hook languages with no body chunker for
 * that container shape — a TS/JS factory function returning an object literal
 * with methods) or a narrow parent covering only the rows ABOVE the first
 * child (no-hook languages, bd tea-rags-mcp-b7k3). Everything below the first
 * child — the statements after a nested `def`, a class attribute declared
 * between two methods — landed in no chunk and was unsearchable.
 *
 * Invariants pinned here, through the real `TreeSitterChunker`:
 *   1. every non-blank row of the container is inside some chunk's line
 *      coverage (`lineRanges` when present, else `startLine..endLine`);
 *   2. no two chunks of a file share a symbolId;
 *   3. the container chunk stays NARROW (b7k3): it never carries a child's
 *      rows, so it is never the full container range.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function coveredLines(chunks: CodeChunk[]): Set<number> {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  return covered;
}

/** 1-based line numbers of every non-blank row of `code`. */
function nonBlankLines(code: string): number[] {
  return code
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text.trim() !== "")
    .map(({ line }) => line);
}

function expectEveryLineCovered(code: string, chunks: CodeChunk[]): void {
  const covered = coveredLines(chunks);
  const lines = code.split("\n");
  const missing = nonBlankLines(code)
    .filter((l) => !covered.has(l))
    .map((l) => `${l}: ${lines[l - 1]}`);
  expect(missing).toEqual([]);
}

function expectUniqueSymbolIds(chunks: CodeChunk[]): void {
  const ids = chunks.map((c) => c.metadata.symbolId).filter((id): id is string => id !== undefined);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  expect(duplicates).toEqual([]);
}

describe("TreeSitterChunker — container remainder (bd tea-rags-mcp-deoki)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  describe("python (no hook chain — the b7k3 narrow-parent branch)", () => {
    it("keeps the statements AFTER a nested def inside the enclosing function's chunk", async () => {
      const code = `def test_options_work(app, client):
    @app.route("/", methods=["GET", "POST"])
    def index():
        return "Hello World, padded past the fifty-char floor"

    rv = client.open("/", method="OPTIONS")
    assert sorted(rv.allow) == ["GET", "HEAD", "OPTIONS", "POST"]
    assert rv.data == b""
`;
      const chunks = await chunker.chunk(code, "tests/test_basic.py", "python");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const parent = chunks.find((c) => c.metadata.symbolId === "test_options_work");
      expect(parent).toBeDefined();
      expect(parent!.content).toContain('rv = client.open("/", method="OPTIONS")');
      // b7k3: the parent never re-carries the child it extracted.
      expect(parent!.content).not.toContain('return "Hello World');
      expect(parent!.metadata.lineRanges).toEqual([
        { start: 1, end: 1 },
        { start: 6, end: 8 },
      ]);
      expect(chunks.some((c) => c.metadata.symbolId === "test_options_work#index")).toBe(true);
    });

    it("keeps class attributes declared between and after methods in the ONE class chunk", async () => {
      const code = `class Config:
    """Configuration holder with attributes around its methods."""
    DEFAULTS = {"debug": False, "testing": False, "secret_key": None}

    def get_namespace(self, namespace, lowercase=True):
        """Return a dict of the options matching the namespace prefix."""
        return {k: v for k, v in self.items() if k.startswith(namespace)}

    ENV_PREFIX = "FLASK_" + "padding-so-this-line-is-substantive"

    def from_prefixed_env(self, prefix="FLASK"):
        """Load any environment variables that start with the prefix."""
        return self.update_from_environment_variables(prefix)

    TRAILING_ATTRIBUTE = "declared after the last method on purpose"
`;
      const chunks = await chunker.chunk(code, "config.py", "python");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const classChunks = chunks.filter((c) => c.metadata.symbolId === "Config");
      expect(classChunks).toHaveLength(1);
      const [classChunk] = classChunks;
      expect(classChunk.metadata.chunkType).toBe("class");
      expect(classChunk.content).toContain("ENV_PREFIX");
      expect(classChunk.content).toContain("TRAILING_ATTRIBUTE");
      expect(classChunk.content).not.toContain("def get_namespace");
      expect(classChunk.content).not.toContain("def from_prefixed_env");
    });
  });

  describe("typescript (hook branch — a FUNCTION container the class-body hook never serves)", () => {
    it("keeps a factory's own statements next to the object-literal methods it returns", async () => {
      const code = `export function createAncestorLinearizer(policy: AncestorPolicy): AncestorLinearizer {
  const cache = new Map<string, string[]>();
  const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;
  return {
    linearize(className: string): string[] {
      const cached = cache.get(className);
      if (cached) return cached;
      const order = policy.walk(className, maxDepth);
      cache.set(className, order);
      return order;
    },
    reset(): void {
      cache.clear();
      policy.onReset?.("linearizer cache cleared by caller");
    },
  };
}
`;
      const chunks = await chunker.chunk(code, "src/linearizer.ts", "typescript");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const container = chunks.find((c) => c.metadata.symbolId === "createAncestorLinearizer");
      expect(container).toBeDefined();
      expect(container!.content).toContain("const cache = new Map<string, string[]>();");
      expect(container!.content).not.toContain("cache.set(className, order);");
    });

    it("emits no header-only chunk when the header and closing brace are all a class has outside its members", async () => {
      // Every extracted member already carries the class header as its
      // hierarchy prefix, so a `class X extends Y {` + `}` chunk holds no code.
      const code = `export class OllamaTimeoutError extends EmbeddingError {
  constructor(url: string, timeoutMs: number) {
    super(\`Ollama request to \${url} timed out after \${timeoutMs}ms\`);
  }
}
`;
      const chunks = await chunker.chunk(code, "src/errors.ts", "typescript");

      expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["OllamaTimeoutError#constructor"]);
    });
  });

  describe("javascript (hook branch — same factory shape)", () => {
    it("keeps a factory's own statements next to the object-literal methods it returns", async () => {
      const code = `function createDeletionOutcome(store, logger) {
  const removed = [];
  const failed = new Map();
  logger.debug("deletion outcome tracker created for store", store.name);
  return {
    recordRemoved(path) {
      removed.push(path);
      logger.debug("removed path from the store index", path);
    },
    recordFailed(path, error) {
      failed.set(path, error);
      logger.warn("failed to remove path from the store", path, error);
    },
  };
}
`;
      const chunks = await chunker.chunk(code, "lib/deletion.js", "javascript");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const container = chunks.find((c) => c.metadata.symbolId === "createDeletionOutcome");
      expect(container).toBeDefined();
      expect(container!.content).toContain("const failed = new Map();");
      expect(container!.content).not.toContain("removed.push(path);");
    });
  });

  describe("shared engine rules", () => {
    it("gives a RECURSED container its own remainder under its composed id", async () => {
      // `register` has object-literal methods of its own, so the hook branch
      // recurses into it as a container rather than emitting it as a leaf.
      const code = `export class Registry {
  register(name: string, installer: Installer): void {
    const key = normalizeRegistryKey(name);
    this.entries.set(key, installer);
    installer.install({
      handle(event: RegistryEvent): void {
        this.dispatcher.dispatch(event, "handled by the registry installer");
      },
    });
    this.log.debug("registered installer under key", key);
  }
}
`;
      const chunks = await chunker.chunk(code, "src/registry.ts", "typescript");

      expectUniqueSymbolIds(chunks);
      const register = chunks.find((c) => c.metadata.symbolId === "Registry#register");
      expect(register).toBeDefined();
      expect(register!.content).toContain("const key = normalizeRegistryKey(name);");
      expect(register!.content).toContain('this.log.debug("registered installer under key", key);');
      expect(register!.content).not.toContain("this.dispatcher.dispatch");
      expect(register!.metadata.parentSymbolId).toBe("Registry");
    });

    it("splits an oversized remainder into #partN windows that each fit and together cover every row", async () => {
      const tail = Array.from(
        { length: 60 },
        (_, i) => `    assert response_${i}.status_code == 200, "request ${i} must succeed"`,
      ).join("\n");
      const code = `def test_many_requests(app, client):
    @app.route("/")
    def index():
        return "Hello World, padded past the fifty-char floor"

${tail}
`;
      const chunks = await chunker.chunk(code, "tests/test_many.py", "python");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);
      const parts = chunks.filter((c) => c.metadata.symbolId?.startsWith("test_many_requests#part"));
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.content.length).toBeLessThanOrEqual(1000);
        expect(part.metadata.parentSymbolId).toBe("test_many_requests");
      }
      expect(chunks.some((c) => c.metadata.symbolId === "test_many_requests")).toBe(false);
    });
  });

  // bd tea-rags-mcp-kn0vj — a const-object NAMESPACE (bd tea-rags-mcp-62hzr) was
  // never a container: its declaration was descended THROUGH so each member
  // became a top-level `X.m` chunk, and the object's non-method properties —
  // every hook's `name: "…"` — landed in no chunk at all.
  describe("const-object namespace (bd tea-rags-mcp-kn0vj)", () => {
    it("keeps a TypeScript namespace's non-method properties in the namespace's own chunk", async () => {
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

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const namespace = chunks.find((c) => c.metadata.symbolId === "typescriptCommentCaptureHook");
      expect(namespace).toBeDefined();
      expect(namespace!.content).toContain('name: "typescript-comment-capture",');
      expect(namespace!.content).toContain("priority: HOOK_PRIORITY_COMMENT_CAPTURE,");
      expect(namespace!.content).not.toContain("ctx.excludedRows.add");

      const members = chunks.filter((c) => c.metadata.name === "filterNode" || c.metadata.name === "process");
      expect(members.map((c) => c.metadata.symbolId)).toEqual([
        "typescriptCommentCaptureHook.filterNode",
        "typescriptCommentCaptureHook.process",
      ]);
      for (const member of members) expect(member.metadata.parentSymbolId).toBe("typescriptCommentCaptureHook");
    });

    it("keeps a JavaScript namespace's non-method properties in the namespace's own chunk", async () => {
      const code = `const jsTestDslFilterHook = {
  name: "js-test-dsl-filter",
  priority: HOOK_PRIORITY_FILTER,

  filterNode(node, code, filePath) {
    if (node.type !== "call_expression") return undefined;
    return isTestFile(filePath) && isDslCall(node, code);
  },

  process(_ctx) {
    // No-op — filterNode handles node-level filtering for this hook.
  },
};
`;
      const chunks = await chunker.chunk(code, "lib/test-dsl-filter.js", "javascript");

      expectEveryLineCovered(code, chunks);
      expectUniqueSymbolIds(chunks);

      const namespace = chunks.find((c) => c.metadata.symbolId === "jsTestDslFilterHook");
      expect(namespace).toBeDefined();
      expect(namespace!.content).toContain('name: "js-test-dsl-filter",');
      expect(namespace!.content).not.toContain("isDslCall(node, code)");

      const members = chunks.filter((c) => c.metadata.name === "filterNode" || c.metadata.name === "process");
      expect(members.map((c) => c.metadata.symbolId)).toEqual([
        "jsTestDslFilterHook.filterNode",
        "jsTestDslFilterHook.process",
      ]);
    });

    it("leaves a namespace whose object nests a method outside its own members on the member-by-member path", async () => {
      const code = `export const outer = {
  label: "outer namespace with a nested object literal",
  inner: {
    deep(value: string): string {
      // Padded so the chunk clears the 50-character content floor.
      return value.trim().toUpperCase();
    },
  },
  shallow(value: string): string {
    // Padded so the chunk clears the 50-character content floor.
    return value.trim().toLowerCase();
  },
};
`;
      const chunks = await chunker.chunk(code, "src/nested.ts", "typescript");

      expect(chunks.find((c) => c.metadata.name === "deep")?.metadata.symbolId).toBe("deep");
      expect(chunks.find((c) => c.metadata.name === "shallow")?.metadata.symbolId).toBe("outer.shallow");
    });
  });
});
