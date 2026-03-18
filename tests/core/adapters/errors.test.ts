import { describe, expect, it } from "vitest";

import { CohereApiError, CohereRateLimitError } from "../../../src/core/adapters/embeddings/cohere/errors.js";
import { EmbeddingError } from "../../../src/core/adapters/embeddings/errors.js";
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from "../../../src/core/adapters/embeddings/ollama/errors.js";
import { OnnxInferenceError, OnnxModelLoadError } from "../../../src/core/adapters/embeddings/onnx/errors.js";
import { OpenAIAuthError, OpenAIRateLimitError } from "../../../src/core/adapters/embeddings/openai/errors.js";
import { VoyageApiError, VoyageRateLimitError } from "../../../src/core/adapters/embeddings/voyage/errors.js";
import { InfraError } from "../../../src/core/adapters/errors.js";
import { GitCliNotFoundError, GitCliTimeoutError } from "../../../src/core/adapters/git/errors.js";
import {
  QdrantOperationError,
  QdrantTimeoutError,
  QdrantUnavailableError,
} from "../../../src/core/adapters/qdrant/errors.js";
import { TeaRagsError } from "../../../src/core/infra/errors.js";

// ---------------------------------------------------------------------------
// InfraError (abstract — tested via concrete subclasses)
// ---------------------------------------------------------------------------
describe("InfraError", () => {
  it("is abstract and cannot be instantiated directly", () => {
    // We verify the prototype chain through concrete classes
    const err = new QdrantUnavailableError("http://localhost:6333");
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Qdrant errors
// ---------------------------------------------------------------------------
describe("QdrantUnavailableError", () => {
  const url = "http://localhost:6333";

  it("instanceof chain: QdrantUnavailableError → InfraError → TeaRagsError → Error", () => {
    const err = new QdrantUnavailableError(url);
    expect(err).toBeInstanceOf(QdrantUnavailableError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_QDRANT_UNAVAILABLE", () => {
    const err = new QdrantUnavailableError(url);
    expect(err.code).toBe("INFRA_QDRANT_UNAVAILABLE");
  });

  it("has httpStatus 503", () => {
    const err = new QdrantUnavailableError(url);
    expect(err.httpStatus).toBe(503);
  });

  it("message includes url", () => {
    const err = new QdrantUnavailableError(url);
    expect(err.message).toContain(url);
  });

  it("toUserMessage() includes url", () => {
    const err = new QdrantUnavailableError(url);
    expect(err.toUserMessage()).toContain(url);
  });

  it("preserves cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new QdrantUnavailableError(url, cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new QdrantUnavailableError(url);
    expect(err.cause).toBeUndefined();
  });
});

describe("QdrantTimeoutError", () => {
  const url = "http://localhost:6333";
  const operation = "search";

  it("instanceof chain: QdrantTimeoutError → InfraError → TeaRagsError → Error", () => {
    const err = new QdrantTimeoutError(url, operation);
    expect(err).toBeInstanceOf(QdrantTimeoutError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_QDRANT_TIMEOUT", () => {
    const err = new QdrantTimeoutError(url, operation);
    expect(err.code).toBe("INFRA_QDRANT_TIMEOUT");
  });

  it("has httpStatus 504", () => {
    const err = new QdrantTimeoutError(url, operation);
    expect(err.httpStatus).toBe(504);
  });

  it("message includes url and operation", () => {
    const err = new QdrantTimeoutError(url, operation);
    expect(err.message).toContain(url);
    expect(err.message).toContain(operation);
  });

  it("preserves cause", () => {
    const cause = new Error("timeout");
    const err = new QdrantTimeoutError(url, operation, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("QdrantOperationError", () => {
  const operation = "upsert";
  const detail = "collection not found";

  it("instanceof chain: QdrantOperationError → InfraError → TeaRagsError → Error", () => {
    const err = new QdrantOperationError(operation, detail);
    expect(err).toBeInstanceOf(QdrantOperationError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_QDRANT_OPERATION_FAILED", () => {
    const err = new QdrantOperationError(operation, detail);
    expect(err.code).toBe("INFRA_QDRANT_OPERATION_FAILED");
  });

  it("has httpStatus 500", () => {
    const err = new QdrantOperationError(operation, detail);
    expect(err.httpStatus).toBe(500);
  });

  it("message includes operation and detail", () => {
    const err = new QdrantOperationError(operation, detail);
    expect(err.message).toContain(operation);
    expect(err.message).toContain(detail);
  });

  it("preserves cause", () => {
    const cause = new Error("internal");
    const err = new QdrantOperationError(operation, detail, cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingError (abstract — tested via concrete subclasses)
// ---------------------------------------------------------------------------
describe("EmbeddingError", () => {
  it("is abstract, verified via OllamaUnavailableError", () => {
    const err = new OllamaUnavailableError("http://localhost:11434");
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Ollama errors
// ---------------------------------------------------------------------------
describe("OllamaUnavailableError", () => {
  const url = "http://localhost:11434";

  it("instanceof chain: OllamaUnavailableError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OllamaUnavailableError(url);
    expect(err).toBeInstanceOf(OllamaUnavailableError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_OLLAMA_UNAVAILABLE", () => {
    const err = new OllamaUnavailableError(url);
    expect(err.code).toBe("INFRA_OLLAMA_UNAVAILABLE");
  });

  it("has httpStatus 503", () => {
    const err = new OllamaUnavailableError(url);
    expect(err.httpStatus).toBe(503);
  });

  it("message includes url", () => {
    const err = new OllamaUnavailableError(url);
    expect(err.message).toContain(url);
  });

  it("toUserMessage() includes url", () => {
    const err = new OllamaUnavailableError(url);
    expect(err.toUserMessage()).toContain(url);
  });

  it("preserves cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new OllamaUnavailableError(url, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("OllamaModelMissingError", () => {
  const model = "nomic-embed-text";
  const url = "http://localhost:11434";

  it("instanceof chain: OllamaModelMissingError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OllamaModelMissingError(model, url);
    expect(err).toBeInstanceOf(OllamaModelMissingError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_OLLAMA_MODEL_MISSING", () => {
    const err = new OllamaModelMissingError(model, url);
    expect(err.code).toBe("INFRA_OLLAMA_MODEL_MISSING");
  });

  it("has httpStatus 503", () => {
    const err = new OllamaModelMissingError(model, url);
    expect(err.httpStatus).toBe(503);
  });

  it("message includes model and url", () => {
    const err = new OllamaModelMissingError(model, url);
    expect(err.message).toContain(model);
    expect(err.message).toContain(url);
  });

  it("toUserMessage() includes model", () => {
    const err = new OllamaModelMissingError(model, url);
    expect(err.toUserMessage()).toContain(model);
  });
});

// ---------------------------------------------------------------------------
// ONNX errors
// ---------------------------------------------------------------------------
describe("OnnxModelLoadError", () => {
  const modelPath = "/models/onnx/nomic-embed";

  it("instanceof chain: OnnxModelLoadError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OnnxModelLoadError(modelPath);
    expect(err).toBeInstanceOf(OnnxModelLoadError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_ONNX_MODEL_LOAD_FAILED", () => {
    const err = new OnnxModelLoadError(modelPath);
    expect(err.code).toBe("INFRA_ONNX_MODEL_LOAD_FAILED");
  });

  it("has httpStatus 503", () => {
    const err = new OnnxModelLoadError(modelPath);
    expect(err.httpStatus).toBe(503);
  });

  it("message includes modelPath", () => {
    const err = new OnnxModelLoadError(modelPath);
    expect(err.message).toContain(modelPath);
  });

  it("preserves cause", () => {
    const cause = new Error("file not found");
    const err = new OnnxModelLoadError(modelPath, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("OnnxInferenceError", () => {
  const detail = "tensor shape mismatch";

  it("instanceof chain: OnnxInferenceError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OnnxInferenceError(detail);
    expect(err).toBeInstanceOf(OnnxInferenceError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_ONNX_INFERENCE_FAILED", () => {
    const err = new OnnxInferenceError(detail);
    expect(err.code).toBe("INFRA_ONNX_INFERENCE_FAILED");
  });

  it("has httpStatus 500", () => {
    const err = new OnnxInferenceError(detail);
    expect(err.httpStatus).toBe(500);
  });

  it("message includes detail", () => {
    const err = new OnnxInferenceError(detail);
    expect(err.message).toContain(detail);
  });

  it("preserves cause", () => {
    const cause = new Error("WASM error");
    const err = new OnnxInferenceError(detail, cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// OpenAI errors
// ---------------------------------------------------------------------------
describe("OpenAIRateLimitError", () => {
  it("instanceof chain: OpenAIRateLimitError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OpenAIRateLimitError();
    expect(err).toBeInstanceOf(OpenAIRateLimitError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_OPENAI_RATE_LIMIT", () => {
    const err = new OpenAIRateLimitError();
    expect(err.code).toBe("INFRA_OPENAI_RATE_LIMIT");
  });

  it("has httpStatus 429", () => {
    const err = new OpenAIRateLimitError();
    expect(err.httpStatus).toBe(429);
  });

  it("preserves cause", () => {
    const cause = new Error("429 Too Many Requests");
    const err = new OpenAIRateLimitError(cause);
    expect(err.cause).toBe(cause);
  });
});

describe("OpenAIAuthError", () => {
  it("instanceof chain: OpenAIAuthError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new OpenAIAuthError();
    expect(err).toBeInstanceOf(OpenAIAuthError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_OPENAI_AUTH_FAILED", () => {
    const err = new OpenAIAuthError();
    expect(err.code).toBe("INFRA_OPENAI_AUTH_FAILED");
  });

  it("has httpStatus 401", () => {
    const err = new OpenAIAuthError();
    expect(err.httpStatus).toBe(401);
  });

  it("preserves cause", () => {
    const cause = new Error("invalid api key");
    const err = new OpenAIAuthError(cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Cohere errors
// ---------------------------------------------------------------------------
describe("CohereRateLimitError", () => {
  it("instanceof chain: CohereRateLimitError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new CohereRateLimitError();
    expect(err).toBeInstanceOf(CohereRateLimitError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_COHERE_RATE_LIMIT", () => {
    const err = new CohereRateLimitError();
    expect(err.code).toBe("INFRA_COHERE_RATE_LIMIT");
  });

  it("has httpStatus 429", () => {
    const err = new CohereRateLimitError();
    expect(err.httpStatus).toBe(429);
  });

  it("preserves cause", () => {
    const cause = new Error("rate limited");
    const err = new CohereRateLimitError(cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Voyage errors
// ---------------------------------------------------------------------------
describe("VoyageRateLimitError", () => {
  it("instanceof chain: VoyageRateLimitError → EmbeddingError → InfraError → TeaRagsError → Error", () => {
    const err = new VoyageRateLimitError();
    expect(err).toBeInstanceOf(VoyageRateLimitError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_VOYAGE_RATE_LIMIT", () => {
    const err = new VoyageRateLimitError();
    expect(err.code).toBe("INFRA_VOYAGE_RATE_LIMIT");
  });

  it("has httpStatus 429", () => {
    const err = new VoyageRateLimitError();
    expect(err.httpStatus).toBe(429);
  });

  it("preserves cause", () => {
    const cause = new Error("rate limited");
    const err = new VoyageRateLimitError(cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Git errors
// ---------------------------------------------------------------------------
describe("GitCliNotFoundError", () => {
  it("instanceof chain: GitCliNotFoundError → InfraError → TeaRagsError → Error", () => {
    const err = new GitCliNotFoundError();
    expect(err).toBeInstanceOf(GitCliNotFoundError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_GIT_CLI_NOT_FOUND", () => {
    const err = new GitCliNotFoundError();
    expect(err.code).toBe("INFRA_GIT_CLI_NOT_FOUND");
  });

  it("has httpStatus 503", () => {
    const err = new GitCliNotFoundError();
    expect(err.httpStatus).toBe(503);
  });

  it("has meaningful message", () => {
    const err = new GitCliNotFoundError();
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe("GitCliTimeoutError", () => {
  const command = "git log";
  const timeoutMs = 30000;

  it("instanceof chain: GitCliTimeoutError → InfraError → TeaRagsError → Error", () => {
    const err = new GitCliTimeoutError(command, timeoutMs);
    expect(err).toBeInstanceOf(GitCliTimeoutError);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toBeInstanceOf(TeaRagsError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has code INFRA_GIT_CLI_TIMEOUT", () => {
    const err = new GitCliTimeoutError(command, timeoutMs);
    expect(err.code).toBe("INFRA_GIT_CLI_TIMEOUT");
  });

  it("has httpStatus 504", () => {
    const err = new GitCliTimeoutError(command, timeoutMs);
    expect(err.httpStatus).toBe(504);
  });

  it("message includes command and timeout", () => {
    const err = new GitCliTimeoutError(command, timeoutMs);
    expect(err.message).toContain(command);
    expect(err.message).toContain("30000");
  });

  it("preserves cause", () => {
    const cause = new Error("SIGTERM");
    const err = new GitCliTimeoutError(command, timeoutMs, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("CohereApiError", () => {
  it("has correct code and httpStatus", () => {
    const err = new CohereApiError("empty response");
    expect(err.code).toBe("INFRA_COHERE_API");
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain("empty response");
    expect(err).toBeInstanceOf(TeaRagsError);
  });
});

describe("OnnxPackageMissingError", () => {
  it("has correct code and httpStatus", async () => {
    const { OnnxPackageMissingError } = await import("../../../src/core/adapters/embeddings/onnx/errors.js");
    const err = new OnnxPackageMissingError();
    expect(err.code).toBe("INFRA_ONNX_PACKAGE_MISSING");
    expect(err.httpStatus).toBe(503);
    expect(err).toBeInstanceOf(TeaRagsError);
  });
});

describe("VoyageApiError", () => {
  it("has correct code and httpStatus", () => {
    const err = new VoyageApiError("timeout");
    expect(err.code).toBe("INFRA_VOYAGE_API");
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain("timeout");
    expect(err).toBeInstanceOf(TeaRagsError);
  });
});
