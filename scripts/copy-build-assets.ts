/**
 * `npm run build` post-`tsc` step (bd tea-rags-mcp-bbo1h.3): copy the data
 * assets modules read from disk beside themselves into `build/`.
 *
 * `tsc` emits only what the module graph imports. A module that reads a data
 * file lazily (`new URL("./x.json", import.meta.url)`) keeps that file out of
 * the graph on purpose — importing it would put the parse cost back on module
 * load — so the file reaches `build/` only through this list. A listed asset
 * that does not exist fails the build: a build without it fails later, on
 * first use, inside a chunker worker.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Each asset's path relative to `src/`, copied to the same path under `build/`. */
export const BUILD_ASSETS: readonly string[] = [
  // The Swift SDK substrate, read on first use by `swift/vocabulary/sdk-vocabulary.ts`.
  "core/domains/language/swift/vocabulary/sdk-vocabulary.generated.json",
];

export function copyBuildAssets(repoRoot: string, assets: readonly string[] = BUILD_ASSETS): void {
  for (const asset of assets) {
    const from = join(repoRoot, "src", asset);
    if (!existsSync(from)) throw new Error(`build asset missing: src/${asset}`);
    const to = join(repoRoot, "build", asset);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/* v8 ignore start -- process entry; the copy itself is covered through copyBuildAssets */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  copyBuildAssets(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
/* v8 ignore stop */
