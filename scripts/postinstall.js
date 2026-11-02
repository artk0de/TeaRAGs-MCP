#!/usr/bin/env node
async function main() {
  try {
    const { isBinaryUpToDate, downloadQdrant, QDRANT_VERSION, getPlatformAsset } =
      await import("../build/core/adapters/qdrant/embedded/download.js");

    if (isBinaryUpToDate()) {
      console.error(`[tea-rags] Qdrant v${QDRANT_VERSION} binary already present`);
    } else {
      const asset = getPlatformAsset(process.platform, process.arch);
      console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION} (${asset})...`);
      await downloadQdrant();
      console.error(`[tea-rags] Qdrant binary ready`);
    }
  } catch (err) {
    console.error(`[tea-rags] Postinstall: ${err.message}`);
    console.error(`[tea-rags] Binary will be downloaded on first startup`);
  }

  // Independent step — prebuilt rustc call-site driver from this version's
  // GitHub Release. Best-effort: any failure (offline, no release asset for
  // this platform, stale release, timeout) only logs; `tea-rags rustc-driver
  // install` retries it and also installs the pinned toolchain.
  // Opt out with TEA_RAGS_SKIP_RUSTC_DRIVER_DOWNLOAD=1.
  if (process.env.TEA_RAGS_SKIP_RUSTC_DRIVER_DOWNLOAD !== "1") {
    try {
      const { execFile } = await import("node:child_process");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const { promisify } = await import("node:util");
      const { readFileSync } = await import("node:fs");
      const { downloadRustcDriverRelease } = await import("../build/core/adapters/rustc-driver/release-download.js");
      const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const execFileAsync = promisify(execFile);
      const binary = await downloadRustcDriverRelease(
        {
          version,
          dataDir: process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"),
          platform: process.platform,
          arch: process.arch,
        },
        {
          // Short per-request window so a slow network never stalls `npm install`.
          fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
          run: async (cmd, args) => {
            await execFileAsync(cmd, args, { timeout: 60_000 });
          },
        },
      );
      console.error(`[tea-rags] rustc driver ready: ${binary}`);
    } catch (err) {
      console.error(`[tea-rags] rustc driver download skipped: ${err.message}`);
      console.error(`[tea-rags] Run 'tea-rags rustc-driver install' to install it later`);
    }
  }

  // Independent step — fish completion install. Failure must not abort the
  // package install, so it has its own try/catch inside the script.
  try {
    await import("./install-fish-completion.js");
  } catch (err) {
    console.error(`[tea-rags] fish completion install skipped: ${err.message}`);
  }
}
// Never fail the package install, whatever escaped the per-step handlers.
main()
  .catch((err) => {
    console.error(`[tea-rags] Postinstall: ${err?.message ?? err}`);
  })
  .finally(() => {
    process.exitCode = 0;
  });
