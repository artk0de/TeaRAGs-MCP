/**
 * A file-scope signal's distribution must describe FILES, not chunks.
 *
 * Every `*.file.*` value is stamped identically onto every chunk of its file,
 * so without `stats.dedupeByFile` a 60-chunk file casts 60 votes and every
 * percentile tilts toward large files. Measured on the live tea-rags index
 * before this was fixed: `git.file.ageDays` p50 read 7 days per chunk against
 * 31 days per file, and `git.file.fileChurnCount` p50 read 369 against 128.
 *
 * Those percentiles are not cosmetic — they set label bands, they are what
 * filter presets compare against, and they floor the reranker's adaptive
 * bounds, so a chunk-weighted p95 compresses every normalized file signal.
 *
 * This suite is a standing guard, not a one-off: a new file-scope signal that
 * forgets the flag fails here rather than silently skewing its own bands.
 */

import { describe, expect, it } from "vitest";

import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../../src/core/domains/trajectory/static/payload-signals.js";

const everyDescriptor = [
  ...gitPayloadSignalDescriptors,
  ...CODEGRAPH_SYMBOLS_FILE_SIGNALS,
  ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  ...BASE_PAYLOAD_SIGNALS,
];

const fileScopedWithStats = everyDescriptor.filter((d) => d.key.includes(".file.") && d.stats !== undefined);

describe("file-scope signal statistics count files, not chunks", () => {
  it("covers both enrichment trajectories, so the guard cannot pass vacuously", () => {
    expect(fileScopedWithStats.length).toBeGreaterThan(10);
    expect(fileScopedWithStats.some((d) => d.key.startsWith("git."))).toBe(true);
    expect(fileScopedWithStats.some((d) => d.key.startsWith("codegraph."))).toBe(true);
  });

  it.each(fileScopedWithStats.map((d) => d.key))("%s declares dedupeByFile", (key) => {
    const descriptor = fileScopedWithStats.find((d) => d.key === key);
    expect(descriptor?.stats?.dedupeByFile).toBe(true);
  });
});
