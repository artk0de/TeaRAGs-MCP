import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { takeFootprintCensus, type FootprintCensusDeps } from "../../src/bootstrap/footprint-census.js";

describe("takeFootprintCensus", () => {
  let appDataDir: string;

  beforeEach(() => {
    appDataDir = mkdtempSync(join(tmpdir(), "footprint-census-"));
  });

  afterEach(() => {
    rmSync(appDataDir, { recursive: true, force: true });
  });

  function deps(over: Partial<FootprintCensusDeps> = {}): FootprintCensusDeps {
    return {
      qdrant: {
        listCollections: vi.fn().mockResolvedValue([]),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) } as never,
        getPoint: vi.fn(),
        countPoints: vi.fn().mockResolvedValue(0),
      },
      registry: { list: () => [] },
      appDataDir,
      isBuildInFlight: vi.fn().mockResolvedValue(false),
      ...over,
    };
  }

  it("blocks rows on live-run signals, skips unnameable store entries, and degrades unreadable counts to null", async () => {
    const snapshots = join(appDataDir, "snapshots");
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, "code_locked.json"), "{}");
    // An empty lock file with a fresh mtime reads as a live writer.
    writeFileSync(join(snapshots, "code_locked.indexing.lock"), "");
    writeFileSync(join(snapshots, "code_gone.json"), "12345");
    // Nothing precedes the suffix, so no collection owns this entry.
    writeFileSync(join(snapshots, ".json"), "{}");
    const segment = join(appDataDir, "qdrant", "collections", "code_p_v1");
    mkdirSync(segment, { recursive: true });
    writeFileSync(join(segment, "segment"), "0123456789");

    const rows = await takeFootprintCensus(
      deps({
        qdrant: {
          listCollections: vi.fn().mockResolvedValue(["code_p_v1"]),
          aliases: { listAliases: vi.fn().mockResolvedValue([]) } as never,
          getPoint: vi.fn(),
          countPoints: vi.fn().mockRejectedValue(new Error("qdrant down")),
        },
        isBuildInFlight: vi.fn().mockRejectedValue(new Error("lease unreadable")),
      }),
    );

    const byLogical = new Map(rows.map((row) => [row.logicalName, row]));
    expect([...byLogical.keys()].sort()).toEqual(["code_gone", "code_locked", "code_p"]);
    expect(byLogical.get("code_locked")?.blockedBy).toBe("in use: indexing lock held by a live run");
    expect(byLogical.get("code_gone")).toMatchObject({ findingClass: "store-leftover", bytesOnDisk: 5, chunks: null });
    expect(byLogical.get("code_p")).toMatchObject({
      findingClass: "orphan-collection",
      blockedBy: "in use: build lease is live",
      chunks: null,
      bytesOnDisk: 10,
    });
  });
});
