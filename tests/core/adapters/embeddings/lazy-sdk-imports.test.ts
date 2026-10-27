import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * bd tea-rags-mcp-o4p5l: every process that composes the app — the MCP server,
 * `tea-rags prime` on each SessionStart — imports the embedding factory, so a
 * provider SDK imported at module top level is paid for whichever provider is
 * selected (cohere-ai with its AWS/Bedrock utils alone cost ~150–250 ms of
 * startup). A provider SDK is loaded only once that provider is constructed.
 */
const EMBEDDINGS_DIR = join(import.meta.dirname, "../../../../src/core/adapters/embeddings");
const PROVIDER_SDKS = ["cohere-ai", "openai"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("embedding provider SDKs load lazily", () => {
  it("no embeddings adapter value-imports a provider SDK at module top level", () => {
    const offenders = sourceFiles(EMBEDDINGS_DIR).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return PROVIDER_SDKS.filter((sdk) =>
        new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+"${sdk}"`, "m").test(text),
      ).map((sdk) => `${relative(EMBEDDINGS_DIR, file)} → ${sdk}`);
    });
    expect(offenders).toEqual([]);
  });
});
