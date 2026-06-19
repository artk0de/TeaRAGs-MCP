import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";

const baseStatus = {
  status: "indexed" as const,
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

function primeWith(embedding: NonNullable<PrimeData["status"]["infraHealth"]>["embedding"]): PrimeData {
  return {
    path: "/repo",
    projectName: null,
    status: {
      ...baseStatus,
      infraHealth: { qdrant: baseQdrant, embedding },
    },
    metrics: null,
    drift: null,
    update: null,
  };
}

const at = new Date("2026-05-13T00:00:00Z");

describe("formatPrime — Infra section (embedding endpoints)", () => {
  it("renders a single primary badge when no fallback is configured", () => {
    const out = formatPrime(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://127.0.0.1:11434",
        primaryAvailable: true,
      }),
      at,
    );
    expect(out).toContain("embedding: ollama · primary http://127.0.0.1:11434 (available)");
    expect(out).not.toContain("fallback");
  });

  it("renders both primary and fallback badges, each with its own status", () => {
    const out = formatPrime(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: true,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      }),
      at,
    );
    expect(out).toContain(
      "embedding: ollama · primary http://gpu-server:11434 (available) · fallback http://127.0.0.1:11434 (available)",
    );
  });

  it("shows primary (unavailable) while fallback stays (available) under failover", () => {
    const out = formatPrime(
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

  it("falls back to the overall availability for the primary badge when primaryAvailable is absent", () => {
    // Legacy producer / non-ollama provider that does not expose checkPrimaryHealth:
    // primaryAvailable is undefined → primary badge mirrors `available`.
    const out = formatPrime(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://127.0.0.1:11434",
      }),
      at,
    );
    expect(out).toContain("embedding: ollama · primary http://127.0.0.1:11434 (available)");
  });

  it("marks the fallback badge (unknown) when fallbackUrl is set but its health was not probed", () => {
    const out = formatPrime(
      primeWith({
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: true,
        fallbackUrl: "http://127.0.0.1:11434",
      }),
      at,
    );
    expect(out).toContain("fallback http://127.0.0.1:11434 (unknown)");
  });

  it("keeps the legacy headline form for providers without a url (e.g. onnx)", () => {
    const out = formatPrime(
      primeWith({
        available: true,
        provider: "onnx",
      }),
      at,
    );
    expect(out).toContain("embedding: available · onnx");
    expect(out).not.toContain("primary");
    expect(out).not.toContain(" at undefined");
  });
});
