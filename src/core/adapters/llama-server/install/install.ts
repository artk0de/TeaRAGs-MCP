// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Install llama-server from the pinned llama.cpp release: download the
 * platform's archive (and the cudart companion for cuda) sha256-verified,
 * extract both into one staging dir, check llama-server is there, publish
 * atomically as `<dataDir>/llama.cpp/<build>-<backend>/`.
 */

import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerifiedFile, publishArchive, type NativeAssetDeps } from "../../native-assets/index.js";
import { findLlamaServerInInstall, llamaCppInstallRoot, type LlamaServerFsProbe } from "../binary.js";
import { LlamaServerBinaryMissingError } from "./errors.js";
import type { LlamaServerBackend } from "./gpu-backend.js";
import { LLAMA_CPP_BUILD, llamaCppAssetsFor, type LlamaCppReleaseAsset } from "./llama-cpp-assets.js";

const LLAMA_CPP_RELEASE_BASE_URL = "https://github.com/ggml-org/llama.cpp/releases/download";

const LOCAL_FS: LlamaServerFsProbe = { exists: existsSync, listDir: (p) => readdirSync(p) };

export interface LlamaServerInstallOptions {
  dataDir: string;
  platform: NodeJS.Platform;
  arch: string;
  backend: LlamaServerBackend;
}

function requireLlamaServer(installDir: string): string {
  const binary = findLlamaServerInInstall(installDir, LOCAL_FS);
  if (binary === undefined) {
    throw new LlamaServerBinaryMissingError(LLAMA_CPP_BUILD, installDir);
  }
  return binary;
}

/** Installs into `<dataDir>/llama.cpp/<build>-<backend>/`; returns the llama-server path. */
export async function downloadLlamaServer(
  opts: LlamaServerInstallOptions,
  deps: NativeAssetDeps & { run: (cmd: string, args: string[]) => Promise<void> },
): Promise<string> {
  const assets = llamaCppAssetsFor(opts.platform, opts.arch, opts.backend);
  const root = llamaCppInstallRoot(opts.dataDir);
  const targetDir = join(root, `${LLAMA_CPP_BUILD}-${opts.backend}`);
  if (existsSync(targetDir)) return requireLlamaServer(targetDir);

  const downloadDir = join(root, ".downloads");
  const download = async (asset: LlamaCppReleaseAsset): Promise<string> =>
    downloadVerifiedFile(
      {
        url: `${LLAMA_CPP_RELEASE_BASE_URL}/${LLAMA_CPP_BUILD}/${asset.asset}`,
        sha256: asset.sha256,
        fileName: asset.asset,
      },
      downloadDir,
      deps,
    );
  const archive = await download(assets);
  const companion = assets.companion === undefined ? undefined : await download(assets.companion);

  await publishArchive(
    archive,
    targetDir,
    async (stagingDir) => {
      if (companion !== undefined) await deps.run("tar", ["-xf", companion, "-C", stagingDir]);
      requireLlamaServer(stagingDir);
    },
    deps,
  );
  // Archives are only the transport; the published tree is the install.
  await rm(downloadDir, { recursive: true, force: true });
  return requireLlamaServer(targetDir);
}
