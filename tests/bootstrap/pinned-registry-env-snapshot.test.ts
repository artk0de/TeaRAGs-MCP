/**
 * What an index run PINS into its registry entry (bd tea-rags-mcp-h4l6k).
 *
 * Live: all 21 registry entries pinned TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES=10000
 * — the code default at the time each was indexed, materialized by the 9vpnz
 * snapshot — so the BREAKING default of 5000 applied to no project at all. A
 * pin now records an operator's decision, never a default: only the groups the
 * run's env explicitly set (under any spelling, including a value the registry
 * replayed into it) are persisted. A key left at its default keeps following
 * the code default of whatever release runs next.
 *
 * `buildRegistryEnvSnapshot` stays the FULL resolved set — the env drift axis
 * compares with it.
 */

import { describe, expect, it } from "vitest";

import { buildPinnedRegistryEnvSnapshot, buildRegistryEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";

describe("buildPinnedRegistryEnvSnapshot", () => {
  it("pins nothing a bare run left at its code default", () => {
    const pinned = buildPinnedRegistryEnvSnapshot(parseAppConfigZod({}));

    expect(pinned).not.toHaveProperty("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES");
    expect(pinned).not.toHaveProperty("INGEST_CHUNK_OVERLAP");
    expect(pinned).not.toHaveProperty("EMBEDDING_PROVIDER");
    // The comparison snapshot still materializes the default.
    expect(buildRegistryEnvSnapshot(parseAppConfigZod({}))).toHaveProperty("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES");
  });

  it("pins an explicitly set key at its parsed value", () => {
    const pinned = buildPinnedRegistryEnvSnapshot(
      parseAppConfigZod({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777", EMBEDDING_PROVIDER: "ollama" }),
    );

    expect(pinned).toMatchObject({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777", EMBEDDING_PROVIDER: "ollama" });
    expect(pinned).not.toHaveProperty("TRAJECTORY_GIT_CHUNK_TIMEOUT_MS");
  });

  it("pins under the canonical name when the env used a deprecated spelling", () => {
    const pinned = buildPinnedRegistryEnvSnapshot(parseAppConfigZod({ GIT_CHUNK_MAX_FILE_LINES: "777" }));

    expect(pinned).toEqual({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777" });
  });

  it("keeps an existing project's replayed pin — even one equal to a default — so no entry loses what it recorded", () => {
    // The registry replays a project's stamp into the run's env, which is what
    // makes it explicit here: an entry pinned at the old 10000 stays at 10000.
    const pinned = buildPinnedRegistryEnvSnapshot(parseAppConfigZod({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000" }));

    expect(pinned).toEqual({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000" });
  });

  it("ignores an empty value, which the parser treats as unset", () => {
    const pinned = buildPinnedRegistryEnvSnapshot(parseAppConfigZod({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "" }));

    expect(pinned).not.toHaveProperty("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES");
  });
});
