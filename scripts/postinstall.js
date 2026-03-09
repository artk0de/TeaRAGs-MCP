#!/usr/bin/env node
async function main() {
  try {
    const { isBinaryPresent, downloadQdrant, QDRANT_VERSION, getPlatformAsset } =
      await import("../build/core/adapters/qdrant/embedded/download.js");

    if (isBinaryPresent()) {
      console.error(`[tea-rags] Qdrant v${QDRANT_VERSION} binary already present`);
      return;
    }

    const asset = getPlatformAsset(process.platform, process.arch);
    console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION} (${asset})...`);
    await downloadQdrant();
    console.error(`[tea-rags] Qdrant binary ready`);
  } catch (err) {
    console.error(`[tea-rags] Postinstall: ${err.message}`);
    console.error(`[tea-rags] Binary will be downloaded on first startup`);
  }
}
main();
