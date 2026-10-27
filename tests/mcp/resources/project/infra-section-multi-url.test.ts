import { describe, expect, it } from "vitest";

import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const at = new Date("2026-05-13T00:00:00Z");
const urls = (ports: number[]) => ports.map((p) => `http://h:${p}`).join(",");
const timedOut = (p: number) => `http://h:${p}: http://h:${p} is unreachable: ETIMEDOUT: request timed out`;
const refused = (p: number) => `http://h:${p}: http://h:${p} is unreachable: ECONNREFUSED: connection refused`;

function embeddingLine(primaryUnavailableReason: string, withFallback = false): string | undefined {
  const data: ProjectDigestData = {
    path: "/repo",
    projectName: null,
    status: {
      status: "indexed",
      isIndexed: true,
      collectionName: "code_abc",
      filesCount: 1,
      chunksCount: 1,
      embeddingModel: "m",
      infraHealth: {
        qdrant: { available: true, url: "http://127.0.0.1:6333", status: "green", optimizerStatus: "ok" },
        embedding: {
          available: true,
          provider: "llama-server",
          url: urls([8091, 8092, 8093, 8094]),
          primaryAvailable: false,
          primaryUnavailableReason,
          ...(withFallback
            ? { fallbackUrl: "http://localhost:8085,http://localhost:8086", fallbackAvailable: true }
            : {}),
        },
      },
    },
    metrics: null,
    drift: null,
  };
  return formatSlimDigest(data, at)
    .split("\n")
    .find((l) => l.startsWith("embedding:"));
}

describe("formatSlimDigest — multi-URL endpoint tiers (q1g6s.3)", () => {
  it("lists URLs once and groups an all-down tier under one short reason", () => {
    expect(embeddingLine([8091, 8092, 8093, 8094].map(timedOut).join("; "), true)).toBe(
      "embedding: llama-server · primary http://h:8091,http://h:8092,http://h:8093,http://h:8094 (unavailable 4/4: ETIMEDOUT)" +
        " · fallback http://localhost:8085,http://localhost:8086 (available)",
    );
  });

  it("names the down URLs when only some are down", () => {
    expect(embeddingLine([8091, 8092].map(timedOut).join("; "))).toContain(
      "(unavailable 2/4: http://h:8091, http://h:8092 — ETIMEDOUT)",
    );
  });

  it("groups mixed reasons by short reason", () => {
    expect(embeddingLine([timedOut(8091), refused(8092), refused(8093)].join("; "))).toContain(
      "(unavailable 3/4: http://h:8091 — ETIMEDOUT; http://h:8092, http://h:8093 — ECONNREFUSED)",
    );
  });

  it("keeps the cached-verdict age next to the short reason (bd sm1ow)", () => {
    const cached = (p: number) => `${timedOut(p)} (cached verdict, age 42 s)`;
    expect(embeddingLine([8091, 8092, 8093, 8094].map(cached).join("; "))).toContain(
      "(unavailable 4/4: ETIMEDOUT (cached verdict, age 42 s))",
    );
  });

  it("falls back to the first clause (<=40 chars) when no error code is present", () => {
    const reason = "http://h:8091: http://h:8091 answered with a very long unexpected explanation text here";
    const out = embeddingLine(reason);
    expect(out).toMatch(/\(unavailable 1\/4: http:\/\/h:8091 — .{1,40}\)/);
  });
});
