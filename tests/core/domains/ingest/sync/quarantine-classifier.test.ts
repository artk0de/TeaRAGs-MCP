import { describe, expect, it } from "vitest";
import { QdrantUnavailableError } from "../../../../../src/core/adapters/qdrant/errors.js";
import {
  ChunkOversizedError,
  FileParseError,
  FileReadError,
  IngestInvariantError,
} from "../../../../../src/core/domains/ingest/errors.js";
import { classifyQuarantinable } from "../../../../../src/core/domains/ingest/sync/quarantine-classifier.js";

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
