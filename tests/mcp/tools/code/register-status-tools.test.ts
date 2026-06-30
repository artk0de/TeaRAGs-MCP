import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/index.js";
import {
  formatBytes,
  formatCollectionDetails,
  formatInfraHealth,
} from "../../../../src/mcp/tools/code/register-status-tools.js";

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

describe("formatBytes", () => {
  it("formats B/KB/MB/GB with one decimal (bytes as integer)", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1_288_490_188)).toBe("1.2 GB");
  });
});

describe("formatCollectionDetails — index size", () => {
  it("renders a human-readable index size line when diskBytes is set", () => {
    expect(formatCollectionDetails({ diskBytes: 1_288_490_188 })).toBe("Index size: 1.2 GB");
  });

  it("returns an empty string when diskBytes is undefined", () => {
    expect(formatCollectionDetails({})).toBe("");
  });
});

describe("formatCollectionDetails — quantization", () => {
  it("renders turbo with the 8x annotation", () => {
    expect(formatCollectionDetails({ quantization: "turbo" })).toBe("Quantization: turbo (8x)");
  });

  it("renders scalar without annotation", () => {
    expect(formatCollectionDetails({ quantization: "scalar" })).toBe("Quantization: scalar");
  });

  it("renders none", () => {
    expect(formatCollectionDetails({ quantization: "none" })).toBe("Quantization: none");
  });

  it("renders both size and quantization on separate lines", () => {
    expect(formatCollectionDetails({ diskBytes: 1_288_490_188, quantization: "turbo" })).toBe(
      "Index size: 1.2 GB\nQuantization: turbo (8x)",
    );
  });
});
