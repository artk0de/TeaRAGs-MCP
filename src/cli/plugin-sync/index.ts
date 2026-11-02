import type { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudePluginSyncAdapter } from "./claude.js";
import { CodexPluginSyncAdapter } from "./codex.js";
import { CursorPluginSyncAdapter, type CursorPluginFs } from "./cursor.js";
import {
  emptyPluginSyncReport,
  type HarnessCliRunner,
  type HarnessPluginSyncAdapter,
  type HarnessPluginSyncReport,
} from "./types.js";

export type {
  HarnessCliRunner,
  HarnessCliRunResult,
  HarnessPluginSyncAdapter,
  HarnessPluginSyncEntry,
  HarnessPluginSyncReport,
  PluginHarness,
  PluginSyncReport,
} from "./types.js";

export interface HarnessPluginSyncDeps {
  /** Version of the tea-rags client now installed — every harness's plugins are brought to this release. */
  clientVersion: string;
  runClaude: HarnessCliRunner;
  runCodex: HarnessCliRunner;
  homedir: string;
  /** `$CODEX_HOME`, default `<homedir>/.codex`. */
  codexHome: string;
  packageRoot: string;
  fs?: CursorPluginFs;
}

/**
 * Brings the tea-rags plugins of every harness to the installed client's
 * release, each through its own channel. One harness failing never stops the
 * others: a thrown adapter becomes a `failed` entry of its own report.
 */
export async function syncHarnessPlugins(deps: HarnessPluginSyncDeps): Promise<HarnessPluginSyncReport> {
  const fsImpl = deps.fs ?? fs;
  const adapters: HarnessPluginSyncAdapter[] = [
    new ClaudePluginSyncAdapter({ runClaude: deps.runClaude, clientVersion: deps.clientVersion }),
    new CodexPluginSyncAdapter({
      runCodex: deps.runCodex,
      clientVersion: deps.clientVersion,
      codexHome: deps.codexHome,
      fs: fsImpl,
    }),
    new CursorPluginSyncAdapter({ homedir: deps.homedir, packageRoot: deps.packageRoot, fs: fsImpl }),
  ];

  const harnesses: HarnessPluginSyncReport["harnesses"] = [];
  for (const adapter of adapters) {
    try {
      harnesses.push({ harness: adapter.harness, report: await adapter.sync() });
    } catch (err) {
      const report = emptyPluginSyncReport();
      report.failed.push({
        id: `${adapter.harness} plugins`,
        reason: err instanceof Error ? err.message : String(err),
      });
      harnesses.push({ harness: adapter.harness, report });
    }
  }
  return { harnesses };
}

/** Runs `<command> <args>` capturing stdout/stderr; a spawn ENOENT reports `missing`. */
export function spawnHarnessCli(spawn: typeof nodeSpawn, command: string): HarnessCliRunner {
  return async (args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve({ code: null, stdout, stderr, missing: err.code === "ENOENT" });
      });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr, missing: false });
      });
    });
}

/** The tea-rags package root — `src/cli/plugin-sync` and `build/cli/plugin-sync` both sit three levels below it. */
export function resolvePackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
