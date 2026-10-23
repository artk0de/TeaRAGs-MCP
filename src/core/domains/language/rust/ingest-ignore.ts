import type { IngestIgnoreContribution } from "../../../contracts/types/ingest-config.js";

/**
 * Cargo output that is never the project's source.
 *
 * - `target/` — the build directory, `OUT_DIR` codegen (bindgen, build-script
 *   output) included.
 * - `cargo vendor` crates — recognised by the `.cargo-checksum.json` Cargo
 *   writes into every vendored crate, never by a bare `vendor/` name: Rails
 *   keeps application code under `vendor/`, and a hand-patched crate without
 *   the checksum is the project's own to index.
 */
export const ingestIgnore: IngestIgnoreContribution = {
  patterns: ["target/"],
  markedDirectories: [{ reason: "crate vendored by `cargo vendor`", entries: [".cargo-checksum.json"] }],
};
