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

  // Independent step — fish completion install. Failure must not abort the
  // package install, so it has its own try/catch inside the script.
  try {
    await import("./install-fish-completion.js");
  } catch (err) {
    console.error(`[tea-rags] fish completion install skipped: ${err.message}`);
  }
}
main();
