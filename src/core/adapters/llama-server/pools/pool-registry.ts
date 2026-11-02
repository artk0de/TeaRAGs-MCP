// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * `<dataDir>/llama-server/pools.json` — the managed llama-server pools this
 * machine runs. The processes are detached, so this file is the only memory of
 * their pids and ports across CLI and server processes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { LlamaServerPoolRegistryCorruptedError } from "./errors.js";

export interface LlamaServerPoolRecord {
  /** Catalog id — the EMBEDDING_MODEL value. */
  model: string;
  ggufPath: string;
  binary: string;
  instances: { pid: number; port: number; logPath: string }[];
  /** Launch args every instance shares; each adds its own `--port`. */
  args: string[];
  startedAt: string;
}

interface LlamaServerPoolsFile {
  pools: LlamaServerPoolRecord[];
}

/** Directory holding `pools.json` and the instance logs. */
export function llamaServerPoolsDir(dataDir: string): string {
  return join(dataDir, "llama-server");
}

export function llamaServerPoolsPath(dataDir: string): string {
  return join(llamaServerPoolsDir(dataDir), "pools.json");
}

/** Every recorded pool; none when `pools.json` does not exist. A corrupt file throws. */
export async function readLlamaServerPoolRecords(dataDir: string): Promise<LlamaServerPoolRecord[]> {
  const path = llamaServerPoolsPath(dataDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    return (JSON.parse(text) as LlamaServerPoolsFile).pools;
  } catch (error) {
    throw new LlamaServerPoolRegistryCorruptedError(path, error as Error);
  }
}

/** Replace `pools.json` atomically: write a sibling temp file, then rename over it. */
export async function writeLlamaServerPoolRecords(dataDir: string, records: LlamaServerPoolRecord[]): Promise<void> {
  const path = llamaServerPoolsPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const file: LlamaServerPoolsFile = { pools: records };
  await writeFile(partial, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(partial, path);
}
