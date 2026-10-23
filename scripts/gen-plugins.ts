/**
 * Regenerates everything derived from `plugins/**`, in dependency order: the
 * agent-context module, then the Claude Code, Codex and Cursor packages with
 * their root marketplace manifests. Output is byte-stable: a second run leaves
 * no diff.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PATHS, writeAgentContextModule } from "./gen-agent-context.js";
import { CLAUDE_PACKAGES_DIR, writeClaudePackages } from "./gen-harness-claude.js";
import { CODEX_HARNESS_DIR, writeCodexHarness } from "./gen-harness-codex.js";
import { CURSOR_HARNESS_DIR, writeCursorHarness } from "./gen-harness-cursor.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await writeAgentContextModule(DEFAULT_PATHS);
console.log("✓ src/mcp/resources/generated/agent-context.ts");
console.log(`✓ ${CLAUDE_PACKAGES_DIR}/<plugin>: ${writeClaudePackages(root)} files`);
console.log(`✓ ${CODEX_HARNESS_DIR}: ${await writeCodexHarness(root)} files`);
console.log(`✓ ${CURSOR_HARNESS_DIR}: ${await writeCursorHarness(root)} files`);
