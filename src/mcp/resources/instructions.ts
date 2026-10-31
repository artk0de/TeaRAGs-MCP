/**
 * MCP server `instructions` derived from the always-on rules core. Claude Code
 * truncates `instructions` at 4,096 chars; the full core stays readable as the
 * `tea-rags://guide/core` resource.
 */

export const INSTRUCTIONS_MAX_CHARS = 4_096;

export const CORE_RESOURCE_URI = "tea-rags://guide/core";

const POINTER = `Full rules continue in MCP resource ${CORE_RESOURCE_URI} (no MCP: \`tea-rags resource ${CORE_RESOURCE_URI}\`).`;

const SEPARATOR = "\n\n";

/** `core` = the always-on core (head + pointer when oversized); `pointer` = the pointer line alone. */
export type ServerInstructionsMode = "core" | "pointer";

/**
 * The core split where `serverInstructions` cuts it: `head` is what the server
 * sends (before the pointer line), `tail` the rest, starting at a block
 * boundary, so `head + tail` restores the core modulo the whitespace between
 * them. The Claude plugin's SessionStart hook injects only the tail
 * (bd tea-rags-mcp-9f0yn.9): the head already arrives as server instructions.
 */
export interface CoreInstructionsSplit {
  head: string;
  tail: string;
}

/** A line that opens a new block: list item, bold run-in heading or heading. */
const BLOCK_START = /\n(?=- |\*\*|#)/g;

/**
 * Cut on a blank line in the second half of the window; else before the last
 * block-opening line there; else on the last line boundary. `undefined` when
 * the core fits `cap` (nothing is cut).
 */
export function splitCoreForInstructions(
  core: string,
  cap: number = INSTRUCTIONS_MAX_CHARS,
): CoreInstructionsSplit | undefined {
  if (core.length <= cap) return undefined;
  const window = core.slice(0, cap - SEPARATOR.length - POINTER.length + 1);
  const half = window.length / 2;
  const blankLine = window.lastIndexOf("\n\n");
  const blockStart = Math.max(-1, ...[...window.matchAll(BLOCK_START)].map((m) => m.index));
  const cut = blankLine > half ? blankLine : blockStart > half ? blockStart : window.lastIndexOf("\n");
  const at = Math.max(cut, 0);
  return { head: core.slice(0, at).trimEnd(), tail: core.slice(at).replace(/^\n+/, "") };
}

/**
 * Core verbatim when it fits `cap`; otherwise its head
 * ({@link splitCoreForInstructions}) followed by one pointer line to the full
 * core. `pointer` mode sends the pointer line alone. Empty core → `undefined`
 * in both modes.
 */
export function serverInstructions(
  core: string,
  cap: number = INSTRUCTIONS_MAX_CHARS,
  mode: ServerInstructionsMode = "core",
): string | undefined {
  if (core === "") return undefined;
  if (mode === "pointer") return POINTER;
  const split = splitCoreForInstructions(core, cap);
  if (split === undefined) return core;
  return `${split.head}${SEPARATOR}${POINTER}`;
}
