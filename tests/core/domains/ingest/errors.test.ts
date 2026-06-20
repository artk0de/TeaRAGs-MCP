import { describe, expect, it } from "vitest";

import {
  ChunkOversizedError,
  CollectionExistsError,
  EmbeddingRejectedError,
  FileParseError,
  FileReadError,
  IngestError,
  IngestInvariantError,
  NotIndexedError,
  PartialDeletionError,
  PipelineNotStartedError,
  QdrantPayloadTooLargeError,
  QuarantinableIngestError,
  ReindexFailedError,
  SnapshotCorruptedError,
  SnapshotMissingError,
} from "../../../../src/core/domains/ingest/errors.js";
import { createDeletionOutcome } from "../../../../src/core/domains/ingest/sync/deletion/outcome.js";
import { TeaRagsError } from "../../../../src/core/infra/errors.js";

describe("IngestError hierarchy", () => {
  describe("IngestError (abstract)", () => {
    it("cannot be instantiated directly", () => {
      // IngestError is abstract — we verify via subclass
      const err = new NotIndexedError("/some/path");
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("NotIndexedError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new NotIndexedError("/projects/my-app");
      expect(err.code).toBe("INGEST_NOT_INDEXED");
      expect(err.httpStatus).toBe(404);
      expect(err.message).toContain("/projects/my-app");
      expect(err.hint).toContain("index_codebase");
      expect(err.name).toBe("NotIndexedError");
    });

    it("instanceof chain is correct", () => {
      const err = new NotIndexedError("/path");
      expect(err).toBeInstanceOf(NotIndexedError);
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("toUserMessage() includes code and hint", () => {
      const err = new NotIndexedError("/path");
      const msg = err.toUserMessage();
      expect(msg).toContain("INGEST_NOT_INDEXED");
      expect(msg).toContain("Hint:");
    });
  });

  describe("CollectionExistsError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new CollectionExistsError("code_abc123");
      expect(err.code).toBe("INGEST_COLLECTION_EXISTS");
      expect(err.httpStatus).toBe(409);
      expect(err.message).toContain("code_abc123");
      expect(err.name).toBe("CollectionExistsError");
    });

    it("instanceof chain is correct", () => {
      const err = new CollectionExistsError("col");
      expect(err).toBeInstanceOf(CollectionExistsError);
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("SnapshotMissingError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new SnapshotMissingError("/data/snapshot.bin");
      expect(err.code).toBe("INGEST_SNAPSHOT_MISSING");
      expect(err.httpStatus).toBe(404);
      expect(err.message).toContain("/data/snapshot.bin");
      expect(err.name).toBe("SnapshotMissingError");
    });

    it("instanceof chain is correct", () => {
      const err = new SnapshotMissingError("/path");
      expect(err).toBeInstanceOf(SnapshotMissingError);
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("SnapshotCorruptedError", () => {
    it("has correct code and message", () => {
      const err = new SnapshotCorruptedError("/data/snapshot.bin");
      expect(err.code).toBe("INGEST_SNAPSHOT_CORRUPTED");
      expect(err.message).toContain("/data/snapshot.bin");
      expect(err).toBeInstanceOf(IngestError);
    });
  });

  describe("ReindexFailedError", () => {
    it("has correct code and preserves cause", () => {
      const cause = new Error("disk full");
      const err = new ReindexFailedError("/path", cause);
      expect(err.code).toBe("INGEST_REINDEX_FAILED");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("/path");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(IngestError);
    });
  });

  describe("PartialDeletionError", () => {
    it("has correct code, httpStatus, and message reflecting failed/attempted counts", () => {
      const outcome = createDeletionOutcome(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
      outcome.markFailed("b.ts");
      outcome.markFailed("d.ts");

      const err = new PartialDeletionError(outcome);

      expect(err.code).toBe("INGEST_PARTIAL_DELETION");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("2 of 5");
      expect(err.hint).toContain("force-reindex");
    });

    it("preserves the outcome reference for downstream inspection", () => {
      const outcome = createDeletionOutcome(["a.ts", "b.ts"]);
      outcome.markFailed("a.ts");

      const err = new PartialDeletionError(outcome);

      expect(err.outcome).toBe(outcome);
      expect(err.outcome.failed.has("a.ts")).toBe(true);
    });

    it("instanceof chain is correct", () => {
      const outcome = createDeletionOutcome(["a.ts"]);
      outcome.markAllFailed();

      const err = new PartialDeletionError(outcome);

      expect(err).toBeInstanceOf(PartialDeletionError);
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("PipelineNotStartedError", () => {
    it("carries the component name and correct error code", () => {
      const err = new PipelineNotStartedError("EnrichmentCoordinator");

      expect(err.code).toBe("INGEST_PIPELINE_NOT_STARTED");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("EnrichmentCoordinator");
      expect(err.hint).toContain("start()");
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
    });
  });

  describe("IngestInvariantError", () => {
    it("carries the detail and correct error code", () => {
      const err = new IngestInvariantError("chunk count cannot be negative");

      expect(err.code).toBe("INGEST_INVARIANT_VIOLATED");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("chunk count cannot be negative");
      expect(err).toBeInstanceOf(IngestError);
      expect(err).toBeInstanceOf(TeaRagsError);
    });
  });

  describe("QuarantinableIngestError subclasses", () => {
    it("ChunkOversizedError carries embed phase and chunk detail", () => {
      const cause = new Error("raw oversized");
      const err = new ChunkOversizedError("src/big.ts", "chunk 12000 > 8192", cause);

      expect(err.code).toBe("INGEST_CHUNK_OVERSIZED");
      expect(err.phase).toBe("embed");
      expect(err.message).toContain("src/big.ts");
      expect(err.message).toContain("12000");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(QuarantinableIngestError);
      expect(err).toBeInstanceOf(IngestError);
    });

    it("EmbeddingRejectedError carries embed phase and rejection detail", () => {
      const cause = new Error("content policy violation");
      const err = new EmbeddingRejectedError("src/bad.ts", "content rejected by model", cause);

      expect(err.code).toBe("INGEST_EMBEDDING_REJECTED");
      expect(err.phase).toBe("embed");
      expect(err.message).toContain("src/bad.ts");
      expect(err.message).toContain("content rejected by model");
      expect(err.cause).toBe(cause);
      expect(err.hint).toContain("retried");
      expect(err).toBeInstanceOf(QuarantinableIngestError);
      expect(err).toBeInstanceOf(IngestError);
    });

    it("QdrantPayloadTooLargeError carries upsert phase", () => {
      const err = new QdrantPayloadTooLargeError("src/huge.ts", "payload 10MB > 1MB limit");

      expect(err.code).toBe("INGEST_PAYLOAD_TOO_LARGE");
      expect(err.phase).toBe("upsert");
      expect(err.message).toContain("src/huge.ts");
      expect(err).toBeInstanceOf(QuarantinableIngestError);
      expect(err).toBeInstanceOf(IngestError);
    });

    it("FileParseError carries parse phase and preserves cause", () => {
      const cause = new Error("unexpected token at line 42");
      const err = new FileParseError("src/broken.ts", "unexpected token", cause);

      expect(err.code).toBe("INGEST_FILE_PARSE_FAILED");
      expect(err.phase).toBe("parse");
      expect(err.message).toContain("src/broken.ts");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(QuarantinableIngestError);
      // A parse failure on real source is usually a chunker bug — nudge to report.
      expect(err.hint).toContain("tea-rags:report-issue");
    });

    it("FileReadError carries fs phase and preserves cause", () => {
      const cause = Object.assign(new Error("EPERM"), { code: "EPERM" });
      const err = new FileReadError("src/locked.ts", "EPERM: operation not permitted", cause);

      expect(err.code).toBe("INGEST_FILE_READ_FAILED");
      expect(err.phase).toBe("fs");
      expect(err.message).toContain("src/locked.ts");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(QuarantinableIngestError);
    });
  });
});
