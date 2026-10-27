import { describe, expect, it } from "vitest";

import { formatFullDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const baseStatus = {
  status: "indexed" as const,
  isIndexed: true,
  collectionName: "code_abc",
  filesCount: 1,
  chunksCount: 1,
  embeddingModel: "test-model",
};

const baseQdrant = {
  available: true,
  url: "http://127.0.0.1:6333",
  status: "green" as const,
  optimizerStatus: "ok",
};

function primeWith(embedding: NonNullable<ProjectDigestData["status"]["infraHealth"]>["embedding"]): ProjectDigestData {
  return {
    path: "/repo",
    projectName: null,
    status: {
      ...baseStatus,
      infraHealth: { qdrant: baseQdrant, embedding },
    },
    metrics: null,
    drift: null,
  };
}

const at = new Date("2026-05-13T00:00:00Z");

describe("formatFullDigest — Infra section (embedding endpoints)", () => {
  it("states why an endpoint is unavailable next to its badge (bd fembu)", () => {
    const out = formatFullDigest(
      primeWith({
        available: true,
        provider: "llama-server",
        url: "http://192.168.1.71:8081",
        primaryAvailable: false,
        primaryUnavailableReason: "EHOSTUNREACH: host unreachable",
        fallbackUrl: "http://127.0.0.1:8080",
        fallbackAvailable: false,
        fallbackUnavailableReason: "port 8080 is held by a non-llama-server process",
      }),
      at,
    );
    expect(out).toContain("primary http://192.168.1.71:8081 (unavailable: EHOSTUNREACH: host unreachable)");
    expect(out).toContain(
      "fallback http://127.0.0.1:8080 (unavailable: port 8080 is held by a non-llama-server process)",
    );
  });

  it("shows primary (unavailable) while fallback stays (available) under failover", () => {
    const out = formatFullDigest(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      }),
      at,
    );
    expect(out).toContain(
      "embedding: ollama · primary http://gpu-server:11434 (unavailable) · fallback http://127.0.0.1:11434 (available)",
    );
  });
});

describe("formatFullDigest — Infra section (both-endpoints-down hint)", () => {
  it("appends a get_index_status hint when both primary and fallback ollama are unavailable", () => {
    const out = formatFullDigest(
      primeWith({
        available: false,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: false,
      }),
      at,
    );
    expect(out).toContain("[hint]");
    expect(out).toContain("get_index_status");
    expect(out).toContain("snapshot at read time");
  });

  it("omits the hint when the fallback is still available under failover", () => {
    const out = formatFullDigest(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      }),
      at,
    );
    expect(out).not.toContain("get_index_status");
  });

  it("omits the hint when the fallback health is unknown (not probed)", () => {
    const out = formatFullDigest(
      primeWith({
        available: false,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
      }),
      at,
    );
    expect(out).not.toContain("get_index_status");
  });

  it("omits the hint for url-less providers (e.g. onnx) even when unavailable", () => {
    const out = formatFullDigest(
      primeWith({
        available: false,
        provider: "onnx",
      }),
      at,
    );
    expect(out).not.toContain("get_index_status");
  });
});

// bd tea-rags-mcp-ye5o — the digest only REPORTS a failed optimizer; the recovery
// is the explicit `tea-rags qdrant recover` command, printed ready to run.
describe("formatFullDigest — Infra section (optimizer failure remedy)", () => {
  const embedding = { available: true, provider: "onnx" };

  function primeWithQdrant(
    qdrant: NonNullable<ProjectDigestData["status"]["infraHealth"]>["qdrant"],
    projectName: string | null,
  ): ProjectDigestData {
    return { ...primeWith(embedding), projectName, status: { ...baseStatus, infraHealth: { qdrant, embedding } } };
  }

  it("prints the recover command under the qdrant line when the optimizer reports an error", () => {
    const out = formatFullDigest(
      primeWithQdrant({ ...baseQdrant, status: "red", optimizerStatus: "error: segment optimization failed" }, "demo"),
      at,
    );
    expect(out).toContain("(optimizer error: segment optimization failed)");
    expect(out).toContain("Run: tea-rags qdrant recover --project demo");
  });

  it("addresses the project by path when it has no alias", () => {
    const out = formatFullDigest(primeWithQdrant({ ...baseQdrant, optimizerStatus: "error: boom" }, null), at);
    expect(out).toContain("Run: tea-rags qdrant recover --path /repo");
  });

  it("prints no recover command for a healthy or unknown optimizer", () => {
    expect(formatFullDigest(primeWithQdrant(baseQdrant, "demo"), at)).not.toContain("qdrant recover");
    expect(formatFullDigest(primeWithQdrant({ ...baseQdrant, optimizerStatus: "unknown" }, "demo"), at)).not.toContain(
      "qdrant recover",
    );
  });
});
