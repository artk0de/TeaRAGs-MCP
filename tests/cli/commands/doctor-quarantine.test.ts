import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCollectionName, validatePath } from "../../../src/core/api/public/index.js";

describe("runQuarantineDoctor", () => {
  let dataDir: string;
  let projectDir: string;
  let collectionName: string;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `doctor-quarantine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectDir = join(dataDir, "project");
    await fs.mkdir(join(dataDir, "snapshots"), { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    // Mirror the command: validatePath canonicalizes (e.g. /var → /private/var on
    // macOS) before the collection name is derived.
    collectionName = resolveCollectionName(await validatePath(projectDir));
  });

  afterEach(async () => {
    delete process.env.TEA_RAGS_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function writeQuarantine(): Promise<void> {
    await fs.writeFile(
      join(dataDir, "snapshots", `${collectionName}.quarantine.json`),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-06-20T00:00:00Z",
        files: {
          "src/big.min.js": {
            errorCode: "INGEST_CHUNK_OVERSIZED",
            errorMessage: "chunk exceeds context",
            phase: "embed",
            firstFailedAt: "2026-06-20T00:00:00Z",
            lastFailedAt: "2026-06-20T00:00:00Z",
            attempts: 3,
          },
          "src/locked.ts": {
            errorCode: "INGEST_FILE_READ_FAILED",
            errorMessage: "EACCES",
            phase: "fs",
            firstFailedAt: "2026-06-20T00:00:00Z",
            lastFailedAt: "2026-06-20T00:00:00Z",
            attempts: 1,
          },
        },
      }),
      "utf-8",
    );
  }

  it("emits the full structured list as JSON for agents", async () => {
    await writeQuarantine();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { runQuarantineDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runQuarantineDoctor({ path: projectDir, json: true });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out);
      expect(parsed.collectionName).toBe(collectionName);
      expect(parsed.count).toBe(2);
      const byPath = Object.fromEntries(parsed.files.map((f: { path: string }) => [f.path, f]));
      expect(byPath["src/big.min.js"].errorCode).toBe("INGEST_CHUNK_OVERSIZED");
      expect(byPath["src/locked.ts"].phase).toBe("fs");
    } finally {
      stdout.mockRestore();
    }
  });

  it("renders a human table listing each quarantined file", async () => {
    await writeQuarantine();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { runQuarantineDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runQuarantineDoctor({ path: projectDir, json: false });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("src/big.min.js");
      expect(out).toContain("INGEST_CHUNK_OVERSIZED");
      expect(out).toContain("src/locked.ts");
      expect(out).toContain("2"); // total count
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports an empty quarantine cleanly", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { runQuarantineDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runQuarantineDoctor({ path: projectDir, json: false });
      const out = stdout.mock.calls
        .map((c) => String(c[0]))
        .join("")
        .toLowerCase();
      expect(out).toContain("no quarantined files");
    } finally {
      stdout.mockRestore();
    }
  });
});
