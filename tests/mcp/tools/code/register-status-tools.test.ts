import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/index.js";
import { formatInfraHealth } from "../../../../src/mcp/tools/code/register-status-tools.js";

type InfraHealth = NonNullable<IndexStatus["infraHealth"]>;

const qdrant: InfraHealth["qdrant"] = { available: true, url: "http://127.0.0.1:6333", status: "green" };

describe("formatInfraHealth — embedding endpoints", () => {
  it("renders both primary and fallback badges with their own health", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: {
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: true,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      },
    });
    expect(out).toContain(
      "Embedding (ollama): primary http://gpu-server:11434 (available), fallback http://127.0.0.1:11434 (available)",
    );
  });

  it("shows primary (unavailable) and fallback (available) under failover", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: {
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      },
    });
    expect(out).toContain(
      "Embedding (ollama): primary http://gpu-server:11434 (unavailable), fallback http://127.0.0.1:11434 (available)",
    );
  });

  it("renders a single primary badge when no fallback is configured", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: { available: true, provider: "ollama", url: "http://127.0.0.1:11434", primaryAvailable: true },
    });
    expect(out).toContain("Embedding (ollama): primary http://127.0.0.1:11434 (available)");
    expect(out).not.toContain("fallback");
  });

  it("keeps the bare availability form for providers without a url (onnx)", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: { available: true, provider: "onnx" },
    });
    expect(out).toContain("Embedding (onnx): available");
    expect(out).not.toContain("primary");
  });
});

describe("formatInfraHealth — Qdrant version", () => {
  const embedding: InfraHealth["embedding"] = { available: true, provider: "onnx" };

  it("renders the running server version next to the qdrant line when set", () => {
    const out = formatInfraHealth({ qdrant: { ...qdrant, version: "1.18.2" }, embedding });
    expect(out).toContain("Qdrant: available · v1.18.2 (http://127.0.0.1:6333)");
  });

  it("omits the version segment when unset", () => {
    const out = formatInfraHealth({ qdrant, embedding });
    expect(out).toContain("Qdrant: available (http://127.0.0.1:6333)");
    expect(out).not.toContain("· v");
  });
});
