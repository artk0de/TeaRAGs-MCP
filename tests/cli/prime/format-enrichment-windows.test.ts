import { afterEach, describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData, PrimeRegistryEntry } from "../../../src/cli/prime/types.js";

const NOW = new Date("2026-05-13T00:00:00Z");

function entry(overrides: Partial<PrimeRegistryEntry> = {}): PrimeRegistryEntry {
  return {
    collectionName: "code_abc",
    path: "/repo",
    name: "myrepo",
    embeddingModel: "jina",
    embeddingDimensions: 768,
    qdrantUrl: "http://qdrant:6333",
    indexedAt: "2026-05-01T00:00:00Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 5,
    ...overrides,
  };
}

function data(overrides: Partial<PrimeData> = {}): PrimeData {
  return {
    path: "/repo",
    projectName: "myrepo",
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "code_abc",
      chunksCount: 100,
      enrichment: {
        git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
      },
    },
    metrics: null,
    drift: null,
    update: null,
    ...overrides,
  };
}

/** Extract the `git:` row from the rendered `## Enrichment` section. */
function gitRow(out: string): string | undefined {
  return out.split("\n").find((l) => l.startsWith("git: "));
}

const WINDOW_ENV = {
  TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
  TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS: "6",
};

describe("formatPrime — git walk windows on the enrichment row", () => {
  afterEach(() => {
    delete process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS;
    delete process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS;
  });

  it("appends both walk windows to the git row when the registry env snapshot carries them", () => {
    const out = formatPrime(data({ registry: entry({ env: WINDOW_ENV }) }), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy · window file 12mo / chunk 6mo");
  });

  it("leaves the git row unchanged when the snapshot carries neither window key", () => {
    const out = formatPrime(data({ registry: entry({ env: { INGEST_CHUNK_SIZE: "2000" } }) }), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy");
  });

  it("leaves the git row unchanged when there is no registry entry at all", () => {
    const out = formatPrime(data(), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy");
  });

  it("renders only the half the snapshot actually declares rather than a default for the missing one", () => {
    const out = formatPrime(data({ registry: entry({ env: { TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS: "6" } }) }), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy · window chunk 6mo");
  });

  it("reads the legacy tuning map when the entry predates the env snapshot", () => {
    const out = formatPrime(data({ registry: entry({ tuning: WINDOW_ENV }) }), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy · window file 12mo / chunk 6mo");
  });

  it("never appends windows to a non-git provider row", () => {
    const out = formatPrime(
      data({
        registry: entry({ env: WINDOW_ENV }),
        status: {
          isIndexed: true,
          status: "indexed",
          collectionName: "code_abc",
          chunksCount: 100,
          enrichment: {
            git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
            "codegraph.symbols": { file: { status: "healthy" }, chunk: { status: "healthy" } },
          },
        },
      }),
      NOW,
    );
    expect(out).toContain("codegraph.symbols: file healthy, chunk healthy\n");
    expect(gitRow(out)).toContain("· window file 12mo / chunk 6mo");
  });

  it("keeps the in-progress marker ahead of the window suffix", () => {
    const out = formatPrime(
      data({
        registry: entry({ env: WINDOW_ENV }),
        status: {
          isIndexed: true,
          status: "indexed",
          collectionName: "code_abc",
          chunksCount: 100,
          enrichment: {
            git: { file: { status: "healthy" }, chunk: { status: "in_progress" } },
          },
        },
      }),
      NOW,
    );
    expect(gitRow(out)).toBe("git: file healthy, chunk in_progress (in progress) · window file 12mo / chunk 6mo");
  });

  it("reports the window the INDEX was built with, not the one the current process is configured for", () => {
    process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS = "99";
    process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS = "99";
    const out = formatPrime(data({ registry: entry({ env: WINDOW_ENV }) }), NOW);
    expect(gitRow(out)).toBe("git: file healthy, chunk healthy · window file 12mo / chunk 6mo");
  });
});
