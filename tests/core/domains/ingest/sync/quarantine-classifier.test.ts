import { describe, expect, it } from "vitest";

import {
  OllamaContextOverflowError,
  OllamaResponseError,
} from "../../../../../src/core/adapters/embeddings/ollama/errors.js";
import { QdrantUnavailableError } from "../../../../../src/core/adapters/qdrant/errors.js";
import {
  ChunkOversizedError,
  EmbeddingRejectedError,
  FileParseError,
  FileReadError,
  IngestInvariantError,
} from "../../../../../src/core/domains/ingest/errors.js";
import {
  classifyEmbeddingQuarantinable,
  classifyQuarantinable,
} from "../../../../../src/core/domains/ingest/sync/quarantine-classifier.js";

describe("classifyQuarantinable", () => {
  const path = "src/foo.ts";

  it("classifies a filesystem ENOENT error as FileReadError (fs phase)", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });

    const result = classifyQuarantinable(err, path);

    expect(result).toBeInstanceOf(FileReadError);
    expect(result?.phase).toBe("fs");
  });

  it("classifies a filesystem EACCES error as FileReadError", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });

    expect(classifyQuarantinable(err, path)).toBeInstanceOf(FileReadError);
  });

  it("classifies a generic parse/chunker throw as FileParseError (parse phase)", () => {
    const err = new Error("tree-sitter: unexpected token");

    const result = classifyQuarantinable(err, path);

    expect(result).toBeInstanceOf(FileParseError);
    expect(result?.phase).toBe("parse");
  });

  it("returns null for a transient infra error (not a poison-pill file)", () => {
    const err = new QdrantUnavailableError("http://localhost:6333");

    expect(classifyQuarantinable(err, path)).toBeNull();
  });

  it("returns null for a programming-invariant violation", () => {
    const err = new IngestInvariantError("pipeline not started");

    expect(classifyQuarantinable(err, path)).toBeNull();
  });

  it("passes an already-quarantinable error through unchanged", () => {
    const err = new ChunkOversizedError(path, "chunk too big");

    expect(classifyQuarantinable(err, path)).toBe(err);
  });

  it("preserves the original error as the cause of the wrapped error", () => {
    const err = Object.assign(new Error("boom"), { code: "EACCES" });

    const result = classifyQuarantinable(err, path);

    expect(result?.cause).toBe(err);
  });
});

describe("classifyEmbeddingQuarantinable", () => {
  const path = "src/big.ts";
  const url = "http://localhost:11434";

  it("classifies an embedding context overflow as ChunkOversizedError (embed phase)", () => {
    const err = new OllamaContextOverflowError(url, 400, "input length exceeds context length");

    const result = classifyEmbeddingQuarantinable(err, path);

    expect(result).toBeInstanceOf(ChunkOversizedError);
    expect(result?.phase).toBe("embed");
  });

  it("classifies a 413 embedding response as EmbeddingRejectedError", () => {
    const err = new OllamaResponseError(url, 413, "payload too large");

    const result = classifyEmbeddingQuarantinable(err, path);

    expect(result).toBeInstanceOf(EmbeddingRejectedError);
    expect(result?.phase).toBe("embed");
  });

  it("classifies a 400 embedding response as EmbeddingRejectedError", () => {
    const err = new OllamaResponseError(url, 400, "malformed input");

    expect(classifyEmbeddingQuarantinable(err, path)).toBeInstanceOf(EmbeddingRejectedError);
  });

  it("returns null for a 5xx embedding response (transient)", () => {
    const err = new OllamaResponseError(url, 503, "service unavailable");

    expect(classifyEmbeddingQuarantinable(err, path)).toBeNull();
  });

  it("returns null for a 429 rate-limit response (transient)", () => {
    const err = new OllamaResponseError(url, 429, "too many requests");

    expect(classifyEmbeddingQuarantinable(err, path)).toBeNull();
  });

  it("returns null for a generic network error (transient)", () => {
    const err = new Error("ECONNRESET");

    expect(classifyEmbeddingQuarantinable(err, path)).toBeNull();
  });

  it("passes an already-quarantinable error through unchanged", () => {
    const err = new ChunkOversizedError(path, "already classified");

    expect(classifyEmbeddingQuarantinable(err, path)).toBe(err);
  });
});
