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
import { writeEnvFile } from "../../../benchmarks/lib/output.mjs";

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
