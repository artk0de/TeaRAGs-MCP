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

describe("formatPrime — Infra section (embedding endpoints)", () => {
  it("includes the primary embedding url when set, and no fallback segment when fallbackUrl is undefined", () => {
    const data: PrimeData = {
      path: "/repo",
      projectName: null,
      status: {
        ...baseStatus,
        infraHealth: {
          qdrant: baseQdrant,
          embedding: {
            available: true,
            provider: "ollama",
            url: "http://127.0.0.1:11434",
          },
        },
      },
      metrics: null,
      drift: null,
      update: null,
    };
    const out = formatPrime(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).toContain("embedding: available · ollama at http://127.0.0.1:11434");
    expect(out).not.toContain("fallback:");
  });

  it("includes a `· fallback: <url>` segment after the primary url when InfraHealth.embedding.fallbackUrl is set", () => {
    const data: PrimeData = {
      path: "/repo",
      projectName: null,
      status: {
        ...baseStatus,
        infraHealth: {
          qdrant: baseQdrant,
          embedding: {
            available: true,
            provider: "ollama",
            url: "http://gpu-server:11434",
            fallbackUrl: "http://127.0.0.1:11434",
          },
        },
      },
      metrics: null,
      drift: null,
      update: null,
    };
    const out = formatPrime(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).toContain(
      "embedding: available · ollama at http://gpu-server:11434 · fallback: http://127.0.0.1:11434",
    );
  });

  it("renders fallback segment even when primary url is absent (registry tracked only the fallback)", () => {
    const data: PrimeData = {
      path: "/repo",
      projectName: null,
      status: {
        ...baseStatus,
        infraHealth: {
          qdrant: baseQdrant,
          embedding: {
            available: false,
            provider: "ollama",
            fallbackUrl: "http://127.0.0.1:11434",
          },
        },
      },
      metrics: null,
      drift: null,
      update: null,
    };
    const out = formatPrime(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).toContain("embedding: unavailable · ollama");
    expect(out).toContain("fallback: http://127.0.0.1:11434");
    expect(out).not.toContain(" at undefined");
  });
});
