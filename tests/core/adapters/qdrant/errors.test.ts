import { afterEach, describe, expect, it } from "vitest";

import { InfraError } from "../../../../src/core/adapters/errors.js";
import {
  AliasOperationError,
  CollectionAlreadyExistsError,
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantPointNotFoundError,
  QdrantRecoveringError,
  QdrantStartingError,
  QdrantTimeoutError,
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

describe("QdrantStartingError / QdrantRecoveringError observability hints", () => {
  const originalPlatform = process.platform;
  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("emits linux-flavored observability commands when platform=linux and pid is provided", () => {
    setPlatform("linux");
    const err = new QdrantStartingError("http://localhost:6333", { pid: 12345 });
    // Linux branch emits `ls /proc/<pid>/fd`
    expect(err.hint).toContain("/proc/12345/fd");
    expect(err.hint).toContain("ps -o pid,etime");
  });

  it("emits win32-flavored observability commands when platform=win32 and pid is provided", () => {
    setPlatform("win32");
    const err = new QdrantRecoveringError("http://localhost:6333", { pid: 9999 });
    // win32 branch uses PowerShell Get-Process
    expect(err.hint).toContain("Get-Process -Id 9999");
  });

  it("emits win32-flavored storage hint when platform=win32 and storagePath is provided", () => {
    setPlatform("win32");
    const err = new QdrantStartingError("http://localhost:6333", { storagePath: "C:/data/qdrant" });
    // win32 storage branch uses Get-ChildItem
    expect(err.hint).toContain("Get-ChildItem 'C:/data/qdrant/collections'");
  });

  it("emits posix find when platform=darwin and storagePath is provided", () => {
    setPlatform("darwin");
    const err = new QdrantStartingError("http://localhost:6333", { storagePath: "/data/qdrant" });
    // posix storage branch uses find
    expect(err.hint).toContain("find '/data/qdrant/collections'");
    // darwin pid branch is the default branch in tests, no need to assert here
  });

  it("omits observability section entirely when no details supplied", () => {
    const err = new QdrantStartingError("http://localhost:6333");
    // Empty obs → no "To observe progress externally" preamble appended
    expect(err.hint).not.toContain("To observe progress externally");
  });

  // Invariant #2: pid AND storagePath supplied together → hint carries BOTH the
  // pid command line AND the storage command line (not one at the expense of the
  // other). Existing tests above cover each branch in isolation; this pins the
  // combined path on a single fixed platform.
  it("includes BOTH pid and storage command lines when pid+storagePath supplied together (linux)", () => {
    setPlatform("linux");
    const err = new QdrantStartingError("http://localhost:6333", { pid: 4242, storagePath: "/data/qdrant" });
    // pid branch (linux)
    expect(err.hint).toContain("ps -o pid,etime,time,command -p 4242");
    expect(err.hint).toContain("/proc/4242/fd");
    // storage branch (posix)
    expect(err.hint).toContain("find '/data/qdrant/collections'");
    // observability preamble present
    expect(err.hint).toContain("To observe progress externally");
  });

  // Invariant #3 (Recovering half): no details → no observability block. The
  // Starting half is already pinned above ("omits observability section …").
  it("QdrantRecoveringError omits observability section entirely when no details supplied", () => {
    const err = new QdrantRecoveringError("http://localhost:6333");
    expect(err.hint).not.toContain("To observe progress externally");
  });
});

// Invariant #1: each error class constructed → stable (code, httpStatus) pair.
// UNAVAILABLE/503 and TIMEOUT/504 are pinned in tests/core/adapters/errors.test.ts;
// this block pins the four remaining classes from the taxonomy table.
describe("Qdrant error taxonomy — (code, httpStatus) pairs", () => {
  it("QdrantStartingError → INFRA_QDRANT_STARTING / 503", () => {
    const err = new QdrantStartingError("http://localhost:6333");
    expect(err.code).toBe("INFRA_QDRANT_STARTING");
    expect(err.httpStatus).toBe(503);
  });

  it("QdrantRecoveringError → INFRA_QDRANT_RECOVERING / 503", () => {
    const err = new QdrantRecoveringError("http://localhost:6333");
    expect(err.code).toBe("INFRA_QDRANT_RECOVERING");
    expect(err.httpStatus).toBe(503);
  });

  it("QdrantPointNotFoundError → INFRA_QDRANT_POINT_NOT_FOUND / 404", () => {
    const err = new QdrantPointNotFoundError("pt-1", "code_abc");
    expect(err.code).toBe("INFRA_QDRANT_POINT_NOT_FOUND");
    expect(err.httpStatus).toBe(404);
  });

  it("CollectionAlreadyExistsError → INFRA_COLLECTION_ALREADY_EXISTS / 409", () => {
    const err = new CollectionAlreadyExistsError("code_abc");
    expect(err.code).toBe("INFRA_COLLECTION_ALREADY_EXISTS");
    expect(err.httpStatus).toBe(409);
  });
});

// Invariant #4: raw error goes into `cause`, never interpolated into `message`
// (typed-errors rule: external/raw text lives in cause, not the typed message).
// The cause-*preservation* half is pinned per-class elsewhere; this pins the
// *non-interpolation* half across every cause-taking Qdrant error.
describe("typed-errors rule: cause preserved, never interpolated into message", () => {
  const SECRET = "RAW_CAUSE_9f3ac71e_must_not_leak_into_message";
  const cause = new Error(SECRET);

  const constructors: [string, () => InfraError][] = [
    ["QdrantUnavailableError", () => new QdrantUnavailableError("http://localhost:6333", cause)],
    ["QdrantStartingError", () => new QdrantStartingError("http://localhost:6333", { pid: 1 }, cause)],
    ["QdrantRecoveringError", () => new QdrantRecoveringError("http://localhost:6333", { pid: 1 }, cause)],
    ["QdrantTimeoutError", () => new QdrantTimeoutError("http://localhost:6333", "search", cause)],
    ["QdrantOperationError", () => new QdrantOperationError("upsert", "boom", cause)],
    ["AliasOperationError", () => new AliasOperationError("switch", "boom", cause)],
    ["QdrantPointNotFoundError", () => new QdrantPointNotFoundError("pt-1", "code_abc", cause)],
    ["CollectionAlreadyExistsError", () => new CollectionAlreadyExistsError("code_abc", cause)],
    ["QdrantOptimizationInProgressError", () => new QdrantOptimizationInProgressError("code_abc", cause)],
  ];

  it("keeps the raw error in cause and out of message for every cause-taking error", () => {
    for (const [name, make] of constructors) {
      const err = make();
      expect(err.cause, name).toBe(cause);
      expect(err.message, name).not.toContain(SECRET);
    }
  });
});
