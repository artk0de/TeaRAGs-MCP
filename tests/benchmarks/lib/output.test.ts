/**
 * The tuned env file describes the project that was tuned, so it belongs in
 * THAT project's directory — which is where `tea-rags tune --project X` looks
 * for it (`join(resolved.path, "tuned_environment_variables.env")`) before
 * merging the measured envs into the registry (tea-rags-mcp-ifmfi).
 *
 * The benchmark used to write it beside its own script instead, so the registry
 * write silently found nothing whenever the tuned project was not the tea-rags
 * checkout itself.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { config } from "../../../benchmarks/lib/config.mjs";
// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { detectQdrantMode, printSummary, printUsage, writeEnvFile } from "../../../benchmarks/lib/output.mjs";

const OPTIMAL = {
  EMBEDDING_BATCH_SIZE: 512,
  EMBEDDING_CONCURRENCY: 4,
  QDRANT_UPSERT_BATCH_SIZE: 256,
  QDRANT_BATCH_ORDERING: "weak",
  QDRANT_FLUSH_INTERVAL_MS: 100,
  BATCH_FORMATION_TIMEOUT_MS: 50,
  QDRANT_DELETE_BATCH_SIZE: 1000,
  QDRANT_DELETE_CONCURRENCY: 4,
  INGEST_TUNE_CHUNKER_POOL_SIZE: 3,
  INGEST_TUNE_FILE_CONCURRENCY: 8,
  INGEST_TUNE_IO_CONCURRENCY: 16,
  QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS: 2000,
  EMBEDDING_TUNE_MIN_BATCH_SIZE: 32,
  TRAJECTORY_GIT_CHUNK_CONCURRENCY: 5,
};

const METRICS = { embeddingRate: 120, storageRate: 900, deletionRate: 300 };

describe("writeEnvFile", () => {
  let projectDir: string;
  let dataDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "tuned-project-"));
    // The history copy lands in <home>/.tea-rags/benchmarks — keep it off the
    // real home directory.
    dataDir = mkdtempSync(join(tmpdir(), "tuned-home-"));
    savedHome = process.env.HOME;
    process.env.HOME = dataDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes the env file into the tuned project's directory", () => {
    const { envPath } = writeEnvFile(OPTIMAL, METRICS, 42, {
      qdrantMode: "external",
      projectPath: projectDir,
    });

    expect(envPath).toBe(join(projectDir, "tuned_environment_variables.env"));
    expect(existsSync(envPath)).toBe(true);
  });

  it("emits the measured values the registry write reads back", () => {
    const { envPath } = writeEnvFile(OPTIMAL, METRICS, 42, {
      qdrantMode: "external",
      projectPath: projectDir,
    });
    const content = readFileSync(envPath, "utf-8");

    expect(content).toContain("EMBEDDING_CONCURRENCY=4");
    expect(content).toContain("QDRANT_UPSERT_BATCH_SIZE=256");
    expect(content).toContain("INGEST_TUNE_CHUNKER_POOL_SIZE=3");
  });

  it("keeps a run-numbered history copy per project, incrementing across runs", () => {
    const first = writeEnvFile(OPTIMAL, METRICS, 42, { qdrantMode: "external", projectPath: projectDir });
    const second = writeEnvFile(OPTIMAL, METRICS, 42, { qdrantMode: "external", projectPath: projectDir });

    expect(first.historyPath).toMatch(/-run1\.env$/);
    expect(second.historyPath).toMatch(/-run2\.env$/);
    expect(existsSync(second.historyPath)).toBe(true);
  });

  it("falls back to the current working directory when no project path is given", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    try {
      const { envPath } = writeEnvFile(OPTIMAL, METRICS, 42, { qdrantMode: "external" });
      expect(envPath).toBe(join(projectDir, "tuned_environment_variables.env"));
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Collects what a printer wrote, with colour codes removed. */
function captureLog(run: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((args) => args.map(String).join(" ").replace(ANSI, ""));
  } finally {
    spy.mockRestore();
  }
}

/** Every knob measured — the shape a full tuning run produces. */
const ALL_KNOBS_TUNED = OPTIMAL;

/**
 * The shape a partial run produces: optional phases are skipped (no Qdrant
 * write access, `--quick`, or an aborted phase), and every skipped knob is
 * recorded as null rather than as a guessed value.
 */
const OPTIONAL_KNOBS_SKIPPED = {
  ...OPTIMAL,
  INGEST_TUNE_CHUNKER_POOL_SIZE: null,
  INGEST_TUNE_FILE_CONCURRENCY: null,
  INGEST_TUNE_IO_CONCURRENCY: null,
  QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS: null,
  EMBEDDING_TUNE_MIN_BATCH_SIZE: null,
  TRAJECTORY_GIT_CHUNK_CONCURRENCY: null,
};

/**
 * The tuned env file records which Qdrant the numbers were measured against —
 * an embedded daemon and a shared remote cluster have different ceilings, so a
 * batch size tuned against one is not evidence for the other. The embedded
 * daemon is only identifiable by its loopback host on a random high port.
 */
describe("detectQdrantMode", () => {
  const savedUrl: string = config.QDRANT_URL;

  afterEach(() => {
    config.QDRANT_URL = savedUrl;
  });

  it("reads a loopback host on a non-default port as the embedded daemon", () => {
    config.QDRANT_URL = "http://127.0.0.1:54321";
    expect(detectQdrantMode()).toBe("embedded");

    config.QDRANT_URL = "http://localhost:41999";
    expect(detectQdrantMode()).toBe("embedded");
  });

  it("reads the canonical 6333 port, and any non-loopback host, as remote", () => {
    config.QDRANT_URL = "http://localhost:6333";
    expect(detectQdrantMode()).toBe("remote");

    // No explicit port — 6333 is the documented default, so this is the
    // user's own Docker Qdrant, not the daemon we started.
    config.QDRANT_URL = "http://localhost";
    expect(detectQdrantMode()).toBe("remote");

    config.QDRANT_URL = "https://qdrant.internal:7000";
    expect(detectQdrantMode()).toBe("remote");
  });

  it("degrades to unknown instead of throwing on an unparseable URL", () => {
    config.QDRANT_URL = "not a url";
    expect(detectQdrantMode()).toBe("unknown");
  });
});

describe("printSummary", () => {
  it("reports every measured knob, grouped by the subsystem it belongs to", () => {
    const printed = captureLog(() => {
      printSummary(ALL_KNOBS_TUNED);
    }).join("\n");

    expect(printed).toContain("Optimal configuration:");
    expect(printed).toMatch(/EMBEDDING_BATCH_SIZE\s+= 512/);
    expect(printed).toMatch(/EMBEDDING_CONCURRENCY\s+= 4/);
    expect(printed).toMatch(/QDRANT_UPSERT_BATCH_SIZE\s+= 256/);
    expect(printed).toMatch(/QDRANT_BATCH_ORDERING\s+= weak/);
    expect(printed).toMatch(/QDRANT_DELETE_CONCURRENCY\s+= 4/);
    expect(printed).toContain("# Pipeline");
    expect(printed).toMatch(/INGEST_TUNE_CHUNKER_POOL_SIZE\s+= 3/);
    expect(printed).toMatch(/INGEST_TUNE_IO_CONCURRENCY\s+= 16/);
    expect(printed).toMatch(/QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS\s+= 2000/);
    expect(printed).toMatch(/EMBEDDING_TUNE_MIN_BATCH_SIZE\s+= 32/);
    expect(printed).toContain("# Git trajectory");
    expect(printed).toMatch(/TRAJECTORY_GIT_CHUNK_CONCURRENCY\s+= 5/);
  });

  it("omits a skipped knob entirely rather than printing a null", () => {
    const printed = captureLog(() => {
      printSummary(OPTIONAL_KNOBS_SKIPPED);
    }).join("\n");

    expect(printed).not.toContain("null");
    expect(printed).not.toContain("# Pipeline");
    expect(printed).not.toContain("INGEST_TUNE_CHUNKER_POOL_SIZE");
    expect(printed).not.toContain("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS");
    expect(printed).not.toContain("EMBEDDING_TUNE_MIN_BATCH_SIZE");
    expect(printed).not.toContain("# Git trajectory");
    // The knobs that WERE measured still get reported.
    expect(printed).toMatch(/EMBEDDING_BATCH_SIZE\s+= 512/);
    expect(printed).toMatch(/QDRANT_UPSERT_BATCH_SIZE\s+= 256/);
  });
});

describe("printUsage", () => {
  it("emits every measured knob as a `claude mcp add` -e flag", () => {
    const printed = captureLog(() => {
      printUsage(ALL_KNOBS_TUNED);
    }).join("\n");

    expect(printed).toContain("claude mcp add tea-rags");
    expect(printed).toContain("-e EMBEDDING_BATCH_SIZE=512");
    expect(printed).toContain("-e EMBEDDING_CONCURRENCY=4");
    expect(printed).toContain("-e QDRANT_UPSERT_BATCH_SIZE=256");
    expect(printed).toContain("-e QDRANT_BATCH_ORDERING=weak");
    expect(printed).toContain("-e QDRANT_FLUSH_INTERVAL_MS=100");
    expect(printed).toContain("-e BATCH_FORMATION_TIMEOUT_MS=50");
    expect(printed).toContain("-e QDRANT_DELETE_BATCH_SIZE=1000");
    expect(printed).toContain("-e QDRANT_DELETE_CONCURRENCY=4");
    expect(printed).toContain("-e INGEST_TUNE_CHUNKER_POOL_SIZE=3");
    expect(printed).toContain("-e INGEST_TUNE_FILE_CONCURRENCY=8");
    expect(printed).toContain("-e INGEST_TUNE_IO_CONCURRENCY=16");
    expect(printed).toContain("-e QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=2000");
    expect(printed).toContain("-e EMBEDDING_TUNE_MIN_BATCH_SIZE=32");
    expect(printed).toContain("-e TRAJECTORY_GIT_CHUNK_CONCURRENCY=5");
  });

  it("never emits a flag for a knob that was skipped, and closes the command", () => {
    const lines = captureLog(() => {
      printUsage(OPTIONAL_KNOBS_SKIPPED);
    });
    const flags = lines.filter((line) => line.trim().startsWith("-e "));

    expect(flags.join("\n")).not.toContain("null");
    expect(flags.some((line) => line.includes("INGEST_TUNE_"))).toBe(false);
    expect(flags.some((line) => line.includes("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS"))).toBe(false);
    expect(flags.some((line) => line.includes("EMBEDDING_TUNE_MIN_BATCH_SIZE"))).toBe(false);
    expect(flags.some((line) => line.includes("TRAJECTORY_GIT_CHUNK_CONCURRENCY"))).toBe(false);
    // The eight always-measured knobs remain, and the last one ends the
    // shell command rather than continuing onto a line that never comes.
    expect(flags).toHaveLength(8);
    expect(flags.at(-1)?.endsWith("\\")).toBe(false);
  });
});
