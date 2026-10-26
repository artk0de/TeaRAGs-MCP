import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/dto/ingest.js";
import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const NOW = new Date("2026-10-23T12:00:00Z");

function data(rustcDriver?: IndexStatus["rustcDriver"]): ProjectDigestData {
  return {
    path: "/repo",
    projectName: "repo",
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
      lastUpdated: NOW,
      ...(rustcDriver ? { rustcDriver } : {}),
    },
    metrics: null,
    drift: null,
  };
}

describe("formatSlimDigest — rustc driver line", () => {
  it("renders one driver line when the status carries one", () => {
    const out = formatSlimDigest(
      data({ outcome: "indexed", cacheHit: false, units: 412, failedCrates: ["servo-capi-tests"], wallMs: 648_000 }),
      NOW,
    );
    expect(out.split("\n").filter((l) => l.startsWith("rustc driver:"))).toEqual([
      "rustc driver: indexed (cargo check ran build scripts and proc macros) · units 412 · failed 1 (servo-capi-tests) · 648 s",
    ]);
  });

  it("renders the unavailable and off variants", () => {
    expect(formatSlimDigest(data({ outcome: "unavailable", hint: "get a toolchain" }), NOW)).toContain(
      "rustc driver: unavailable — Rust call edges are static-only (lower bound); get a toolchain",
    );
    expect(formatSlimDigest(data({ outcome: "off" }), NOW)).toContain("rustc driver: off (CODEGRAPH_RUST_DRIVER=off)");
  });

  it("renders nothing when the status is absent", () => {
    expect(formatSlimDigest(data(), NOW)).not.toContain("rustc driver");
  });
});
