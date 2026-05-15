import { afterEach, describe, expect, it } from "vitest";

import { InfraError } from "../../../../src/core/adapters/errors.js";
import {
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantRecoveringError,
  QdrantStartingError,
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
});
