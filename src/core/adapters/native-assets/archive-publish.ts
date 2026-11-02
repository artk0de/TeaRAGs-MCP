// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Atomic archive publish: extract into `<targetDir>.staging`, let the caller
 * verify the staged tree (e.g. the binary runs), then rename staging into
 * place. A failed extract or verify leaves neither directory behind, so a
 * present `targetDir` is always a complete, verified install.
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";

async function isPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract `archivePath` (.tar.gz or .zip — `tar -xf` reads zip on Windows 10+)
 * and publish it as `targetDir`. An existing `targetDir` is returned untouched.
 */
export async function publishArchive(
  archivePath: string,
  targetDir: string,
  verify: (stagingDir: string) => Promise<void>,
  deps: { run: (cmd: string, args: string[]) => Promise<void> },
): Promise<string> {
  if (await isPresent(targetDir)) return targetDir;

  const stagingDir = `${targetDir}.staging`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await deps.run("tar", ["-xf", archivePath, "-C", stagingDir]);
    await verify(stagingDir);
    await rename(stagingDir, targetDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return targetDir;
}
