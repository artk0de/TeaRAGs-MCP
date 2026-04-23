import { describe, expect, it } from "vitest";

import { InfraError } from "../../../../src/core/adapters/errors.js";
import {
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantUnavailableError,
} from "../../../../src/core/adapters/qdrant/errors.js";

describe("QdrantOptimizationInProgressError", () => {
  it("sets the correct code, httpStatus, and hint", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");

    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS");
    expect(err.httpStatus).toBe(503);
    expect(err.hint).toContain("optimization");
    expect(err.hint).toContain("force-reindex");
  });

  it("includes the collection name in the message", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");
    expect(err.message).toContain("code_abc");
  });

  it("preserves the underlying cause", () => {
    const root = new Error("aborted");
    const err = new QdrantOptimizationInProgressError("code_abc", root);
    expect(err.cause).toBe(root);
  });

  it("is distinguishable from QdrantOperationError and QdrantUnavailableError", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");
    expect(err).not.toBeInstanceOf(QdrantOperationError);
    expect(err).not.toBeInstanceOf(QdrantUnavailableError);
  });
});
