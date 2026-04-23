import { describe, expect, it } from "vitest";

import {
  CollectionExistsError,
  IngestError,
  NotIndexedError,
  PartialDeletionError,
  ReindexFailedError,
  SnapshotCorruptedError,
  SnapshotMissingError,
} from "../../../../src/core/domains/ingest/errors.js";
import { createDeletionOutcome } from "../../../../src/core/domains/ingest/sync/deletion-outcome.js";
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
});
