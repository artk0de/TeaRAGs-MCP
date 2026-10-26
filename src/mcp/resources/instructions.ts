/**
 * MCP server `instructions` derived from the always-on rules core. Claude Code
 * truncates `instructions` at 4,096 chars; the full core stays readable as the
 * `tea-rags://guide/core` resource.
 */

export const INSTRUCTIONS_MAX_CHARS = 4_096;

export const CORE_RESOURCE_URI = "tea-rags://guide/core";

const POINTER = `Full rules continue in MCP resource ${CORE_RESOURCE_URI} (no MCP: \`tea-rags resource ${CORE_RESOURCE_URI}\`).`;

const SEPARATOR = "\n\n";

/**
 * Core verbatim when it fits `cap`; otherwise its head cut on a blank-line
 * boundary (a line boundary when no blank line lands in the second half),
 * followed by one pointer line to the full core. Empty core → `undefined`.
 */
export function serverInstructions(core: string, cap: number = INSTRUCTIONS_MAX_CHARS): string | undefined {
  if (core === "") return undefined;
  if (core.length <= cap) return core;

  const window = core.slice(0, cap - SEPARATOR.length - POINTER.length + 1);
  const blankLine = window.lastIndexOf("\n\n");
  const cut = blankLine > window.length / 2 ? blankLine : window.lastIndexOf("\n");
  const head = core.slice(0, Math.max(cut, 0)).trimEnd();
  return `${head}${SEPARATOR}${POINTER}`;
}
