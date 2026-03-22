import { describe, expect, it } from "vitest";

import {
  BM25SparseVectorGenerator,
  codeTokenize,
  featureHash,
  generateSparseVector,
} from "../../../../src/core/adapters/qdrant/sparse.js";

// ---------------------------------------------------------------------------
// Task 1: codeTokenize
// ---------------------------------------------------------------------------

describe("codeTokenize", () => {
  it("splits camelCase", () => {
    expect(codeTokenize("getUserProfile")).toEqual(["get", "user", "profile"]);
  });

  it("splits PascalCase", () => {
    expect(codeTokenize("PascalCaseClass")).toEqual(["pascal", "case", "class"]);
  });

  it("splits snake_case", () => {
    expect(codeTokenize("batch_create")).toEqual(["batch", "create"]);
  });

  it("splits SCREAMING_CASE", () => {
    // "my" is a stop word, so filtered out
    expect(codeTokenize("MY_CONSTANT")).toEqual(["constant"]);
    expect(codeTokenize("MAX_RETRY_COUNT")).toEqual(["max", "retry", "count"]);
  });

  it("splits acronyms correctly", () => {
    expect(codeTokenize("XMLParser")).toEqual(["xml", "parser"]);
  });

  it("splits acronym in middle", () => {
    expect(codeTokenize("getHTTPResponse")).toEqual(["get", "http", "response"]);
  });

  it("splits dot.notation", () => {
    expect(codeTokenize("dot.path.notation")).toEqual(["dot", "path", "notation"]);
  });

  it("splits mixed conventions", () => {
    expect(codeTokenize("mixed_camelCase_SCREAMING")).toEqual(["mixed", "camel", "case", "screaming"]);
  });

  it("removes stop words", () => {
    expect(codeTokenize("this is the function")).toEqual(["function"]);
  });

  it("returns empty for empty string", () => {
    expect(codeTokenize("")).toEqual([]);
  });

  it("filters tokens shorter than 2 chars", () => {
    expect(codeTokenize("a b c")).toEqual([]);
  });

  it("lowercases everything", () => {
    expect(codeTokenize("HELLO WORLD")).toEqual(["hello", "world"]);
  });

  it("handles numbers in identifiers", () => {
    expect(codeTokenize("retry3Times")).toEqual(["retry", "times"]);
  });

  it("handles real code content", () => {
    const tokens = codeTokenize("const maxRetries = getConfig().retryCount");
    expect(tokens).toContain("max");
    expect(tokens).toContain("retries");
    expect(tokens).toContain("get");
    expect(tokens).toContain("config");
    expect(tokens).toContain("retry");
    expect(tokens).toContain("count");
  });
});

// ---------------------------------------------------------------------------
// Task 2: featureHash
// ---------------------------------------------------------------------------

describe("featureHash", () => {
  it("returns same index for same token", () => {
    expect(featureHash("function")).toBe(featureHash("function"));
  });

  it("returns index in [0, 65536)", () => {
    const tokens = ["function", "class", "return", "getUserProfile", "MY_CONSTANT", "XMLParser"];
    for (const token of tokens) {
      const idx = featureHash(token);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(65536);
    }
  });

  it("is deterministic across calls", () => {
    const results = Array.from({ length: 10 }, () => featureHash("testToken"));
    expect(new Set(results).size).toBe(1);
  });

  it("has low collision rate on common code tokens", () => {
    const tokens = [
      "function",
      "class",
      "return",
      "const",
      "let",
      "var",
      "import",
      "export",
      "async",
      "await",
      "promise",
      "error",
      "handler",
      "middleware",
      "controller",
      "service",
      "model",
      "view",
      "template",
      "config",
      "database",
      "query",
      "result",
      "response",
      "request",
      "body",
      "header",
      "status",
      "code",
      "message",
      "data",
      "payload",
      "token",
      "user",
      "admin",
      "role",
      "permission",
      "auth",
      "login",
      "logout",
      "session",
      "cookie",
      "cache",
      "redis",
      "queue",
      "worker",
      "job",
      "task",
      "scheduler",
      "cron",
      "event",
      "listener",
      "emit",
      "subscribe",
      "publish",
      "channel",
      "socket",
      "stream",
      "buffer",
      "pipe",
      "transform",
      "filter",
      "map",
      "reduce",
      "sort",
      "search",
      "find",
      "get",
      "set",
      "update",
      "delete",
      "create",
      "remove",
      "insert",
      "upsert",
      "merge",
      "split",
      "join",
      "parse",
      "stringify",
      "encode",
      "decode",
      "hash",
      "encrypt",
      "decrypt",
      "sign",
      "verify",
      "validate",
      "sanitize",
      "escape",
      "format",
      "render",
      "compile",
      "build",
      "bundle",
      "deploy",
      "test",
      "mock",
      "stub",
      "spy",
      "assert",
      "expect",
      "describe",
      "context",
      "before",
      "after",
      "hook",
      "middleware",
      "router",
      "route",
      "path",
      "url",
      "endpoint",
      "method",
    ];

    const indices = tokens.map((t) => featureHash(t));
    const uniqueIndices = new Set(indices).size;
    const collisionRate = 1 - uniqueIndices / tokens.length;
    expect(collisionRate).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Task 3: generateSparseVector
// ---------------------------------------------------------------------------

describe("generateSparseVector", () => {
  it("produces identical vectors for same text (fixes vocabulary isolation)", () => {
    const v1 = generateSparseVector("getUserProfile validation");
    const v2 = generateSparseVector("getUserProfile validation");
    expect(v1.indices).toEqual(v2.indices);
    expect(v1.values).toEqual(v2.values);
  });

  it("splits code tokens into sub-words (fixes no code tokenization)", () => {
    const result = generateSparseVector("getUserProfile");
    // Should have 3 dimensions: get, user, profile
    expect(result.indices).toHaveLength(3);
  });

  it("produces TF-only values without IDF (fixes double IDF)", () => {
    // With single occurrence of each token, TF should be consistent
    const result = generateSparseVector("hello world");
    // All values should be the same (same TF for single occurrence)
    const uniqueValues = new Set(result.values.map((v) => Math.round(v * 1000)));
    expect(uniqueValues.size).toBe(1);
  });

  it("returns empty for empty input", () => {
    const result = generateSparseVector("");
    expect(result.indices).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it("returns empty for stop-words-only input", () => {
    const result = generateSparseVector("the a an is");
    expect(result.indices).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it("has higher TF for repeated tokens", () => {
    const single = generateSparseVector("retry");
    const repeated = generateSparseVector("retry retry retry");

    // Both should have 1 dimension (same token hashed to same bucket)
    expect(single.indices).toHaveLength(1);
    expect(repeated.indices).toHaveLength(1);
    expect(single.indices[0]).toBe(repeated.indices[0]);

    // Repeated should have higher value (higher TF)
    expect(repeated.values[0]).toBeGreaterThan(single.values[0]);
  });

  it("produces positive values", () => {
    const result = generateSparseVector("hello world function class");
    for (const v of result.values) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it("indices are within hash space bounds", () => {
    const result = generateSparseVector("getUserProfile retryWithBackoff XMLParser MY_CONSTANT");
    for (const idx of result.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(65536);
    }
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe("BM25SparseVectorGenerator (backward compat)", () => {
  it("generateSimple delegates to generateSparseVector", () => {
    const result = BM25SparseVectorGenerator.generateSimple("getUserProfile");
    const direct = generateSparseVector("getUserProfile");
    expect(result.indices).toEqual(direct.indices);
    expect(result.values).toEqual(direct.values);
  });

  it("handles empty strings", () => {
    const result = BM25SparseVectorGenerator.generateSimple("");
    expect(result.indices).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });
});
