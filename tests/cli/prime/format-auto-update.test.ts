import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";
import type { CollectionEntry, RegistryAutoUpdateConfig } from "../../../src/core/api/public/index.js";

const NOW = new Date("2026-08-06T12:00:00.000Z");

function registryEntry(autoUpdate?: RegistryAutoUpdateConfig): CollectionEntry {
  return {
    collectionName: "code_x",
    path: "/repo/x",
    name: "proj",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-08-06T00:00:00.000Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 10,
    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
  };
}

function primeData(over: Partial<PrimeData>): PrimeData {
  return {
    digest: "# tea-rags digest — proj\nindexed · collection `code_x` · 10 files / 100 chunks · last indexed: 5m ago\n",
    update: null,
    ...over,
  };
}

describe("formatPrime — auto-update digest line", () => {
  it("eligible → catching up in background", () => {
    const out = formatPrime(
      primeData({
        registry: registryEntry({ enabled: true, targetBranch: "master" }),
        autoUpdateOutcome: "eligible",
      }),
      NOW,
    );
    expect(out).toContain("auto-update: on (master) · catching up in background");
  });

  it("debounced with a successful lastRun → last run summary with age", () => {
    const out = formatPrime(
      primeData({
        registry: registryEntry({
          enabled: true,
          targetBranch: "master",
          lastRun: { at: "2026-08-06T11:57:00.000Z", outcome: "ok", durationMs: 900, filesChanged: 2 },
        }),
        autoUpdateOutcome: "debounced",
      }),
      NOW,
    );
    expect(out).toContain("auto-update: on (master) · last run ok 3m ago");
  });

  it("branch-mismatch → paused line with the exact switch command", () => {
    const out = formatPrime(
      primeData({
        registry: registryEntry({ enabled: true, targetBranch: "master" }),
        autoUpdateOutcome: "branch-mismatch",
      }),
      NOW,
    );
    expect(out).toContain("auto-update: paused — HEAD not on target master; run `index_codebase` to switch the index");
  });

  it("failed lastRun → failure line with age and log path", () => {
    const out = formatPrime(
      primeData({
        registry: registryEntry({
          enabled: true,
          targetBranch: "master",
          lastRun: { at: "2026-08-06T10:00:00.000Z", outcome: "failed", durationMs: 5, filesChanged: 0, error: "boom" },
        }),
        autoUpdateOutcome: "debounced",
        autoUpdateLogPath: "/data/logs/auto-update-proj.log",
      }),
      NOW,
    );
    expect(out).toContain("auto-update: failed 2h ago — see /data/logs/auto-update-proj.log");
  });

  it("no autoUpdateOutcome → digest byte-identical to the pre-hpg2 shape (no line)", () => {
    const out = formatPrime(primeData({ registry: registryEntry() }), NOW);
    expect(out).not.toContain("auto-update:");
  });
});
