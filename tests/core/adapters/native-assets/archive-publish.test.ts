import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishArchive } from "../../../../src/core/adapters/native-assets/index.js";

const execFileAsync = promisify(execFile);
const run = async (cmd: string, args: string[]): Promise<void> => {
  await execFileAsync(cmd, args);
};

describe("publishArchive", () => {
  let dir: string;
  let archivePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archive-publish-"));
    const content = join(dir, "content");
    mkdirSync(join(content, "bin"), { recursive: true });
    writeFileSync(join(content, "bin", "tool"), "tool bytes");
    archivePath = join(dir, "asset.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", content, "bin"]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes a tar.gz made in the test into targetDir", async () => {
    const targetDir = join(dir, "install", "tool-1.0");
    const verify = vi.fn(async (stagingDir: string) => {
      expect(existsSync(join(stagingDir, "bin", "tool"))).toBe(true);
    });

    const published = await publishArchive(archivePath, targetDir, verify, { run });

    expect(published).toBe(targetDir);
    expect(readFileSync(join(targetDir, "bin", "tool"), "utf-8")).toBe("tool bytes");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(existsSync(`${targetDir}.staging`)).toBe(false);
  });

  it("leaves no targetDir and no .staging when verify throws", async () => {
    const targetDir = join(dir, "install", "tool-1.0");

    await expect(
      publishArchive(
        archivePath,
        targetDir,
        async () => {
          throw new Error("binary does not run");
        },
        { run },
      ),
    ).rejects.toThrow(/binary does not run/);

    expect(existsSync(targetDir)).toBe(false);
    expect(existsSync(`${targetDir}.staging`)).toBe(false);
  });

  it("returns an existing targetDir untouched without running the extractor", async () => {
    const targetDir = join(dir, "install", "tool-1.0");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "marker"), "kept");
    const runSpy = vi.fn(run);

    const published = await publishArchive(archivePath, targetDir, async () => {}, { run: runSpy });

    expect(published).toBe(targetDir);
    expect(runSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(targetDir, "marker"), "utf-8")).toBe("kept");
  });
});
