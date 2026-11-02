// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Where the llama-server binary lives. Every consumer resolves it the same way:
 * `LLAMA_SERVER_PATH` → the managed install under `<dataDir>/llama.cpp/` → PATH.
 */

import { join } from "node:path";

import { LLAMA_CPP_BUILD } from "./install/llama-cpp-assets.js";

const LLAMA_SERVER_FILE_NAMES = ["llama-server", "llama-server.exe"] as const;

/** Directory that holds every managed llama.cpp install. */
export function llamaCppInstallRoot(dataDir: string): string {
  return join(dataDir, "llama.cpp");
}

export interface LlamaServerFsProbe {
  exists: (p: string) => boolean;
  listDir: (p: string) => string[];
}

function listDirOrEmpty(dir: string, fs: LlamaServerFsProbe): string[] {
  try {
    return fs.listDir(dir);
  } catch {
    return [];
  }
}

/**
 * llama-server inside an extracted release, at most one level deep: Unix
 * archives hold `llama-<build>/llama-server`, the Windows zip holds
 * `llama-server.exe` at its root. Undefined when absent.
 */
export function findLlamaServerInInstall(installDir: string, fs: LlamaServerFsProbe): string | undefined {
  const dirs = [installDir, ...listDirOrEmpty(installDir, fs).map((entry) => join(installDir, entry))];
  for (const dir of dirs) {
    for (const name of LLAMA_SERVER_FILE_NAMES) {
      const candidate = join(dir, name);
      if (fs.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Build number of a `<build>-<backend>` install dir (`b12032-metal` → 12032); NaN when unparsable. */
function buildNumberOf(installDirName: string): number {
  const match = /^b(\d+)-/.exec(installDirName);
  return match === null ? Number.NaN : Number(match[1]);
}

/** The pinned build first, then newer builds before older ones. */
function compareInstallDirs(a: string, b: string): number {
  const pinnedPrefix = `${LLAMA_CPP_BUILD}-`;
  const aPinned = a.startsWith(pinnedPrefix);
  if (aPinned !== b.startsWith(pinnedPrefix)) return aPinned ? -1 : 1;
  return buildNumberOf(b) - buildNumberOf(a) || a.localeCompare(b);
}

function findManagedLlamaServer(dataDir: string, fs: LlamaServerFsProbe): string | undefined {
  const root = llamaCppInstallRoot(dataDir);
  const installs = listDirOrEmpty(root, fs)
    .filter((name) => !Number.isNaN(buildNumberOf(name)) && !name.endsWith(".staging"))
    .sort(compareInstallDirs);
  for (const name of installs) {
    const binary = findLlamaServerInInstall(join(root, name), fs);
    if (binary !== undefined) return binary;
  }
  return undefined;
}

/** LLAMA_SERVER_PATH → newest managed install under `<dataDir>/llama.cpp/` → PATH; null when none. */
export function resolveLlamaServerBinary(
  deps: LlamaServerFsProbe & {
    env: Record<string, string | undefined>;
    dataDir: string;
    which: (cmd: string) => string | null;
  },
): string | null {
  const explicit = deps.env.LLAMA_SERVER_PATH;
  if (explicit !== undefined && explicit !== "") return explicit;
  return findManagedLlamaServer(deps.dataDir, deps) ?? deps.which("llama-server");
}
