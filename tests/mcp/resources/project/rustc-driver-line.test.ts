import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/dto/ingest.js";
import { formatFullDigest } from "../../../../src/mcp/resources/project/digest.js";
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

describe("formatFullDigest — rustc driver line", () => {
  it("renders one driver line when the status carries one", () => {
    const out = formatFullDigest(
      data({ outcome: "indexed", cacheHit: false, units: 412, failedCrates: ["servo-capi-tests"], wallMs: 648_000 }),
      NOW,
    );
    expect(out.split("\n").filter((l) => l.startsWith("rustc driver:"))).toEqual([
      "rustc driver: indexed (cargo check ran build scripts and proc macros) · units 412 · failed 1 (servo-capi-tests) · 648 s",
    ]);
  });

  it("renders the unavailable and off variants", () => {
    expect(formatFullDigest(data({ outcome: "unavailable", hint: "get a toolchain" }), NOW)).toContain(
      "rustc driver: unavailable — Rust call edges are static-only (lower bound); get a toolchain",
    );
    expect(formatFullDigest(data({ outcome: "off" }), NOW)).toContain("rustc driver: off (CODEGRAPH_RUST_DRIVER=off)");
  });

  // bd tea-rags-mcp-hjbow.9 — a driver installed since the last run: recompute, not install.
  it("renders installed-pending with the recompute command", () => {
    const hint = "tea-rags index-codebase --project repo --force-enrichments codegraph --languages rust";
    expect(formatFullDigest(data({ outcome: "installed-pending", hint }), NOW)).toContain(
      `rustc driver: installed-pending — driver installed since the last codegraph run, Rust call edges are still static-only (lower bound); recompute: ${hint}`,
    );
  });

  it("renders nothing when the status is absent", () => {
    expect(formatFullDigest(data(), NOW)).not.toContain("rustc driver");
  });
});
