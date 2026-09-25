/**
 * MCP tools that already have a dedicated CLI command (bd tea-rags-mcp-8vy3o).
 *
 * `tea-rags call` refuses these and points at the command instead: the CLI
 * command is the supported shell surface for them (progress, `--json`,
 * worktree handling, registry prompts), and a second, thinner path to the same
 * operation would only drift from it. This table is the single place the
 * refusal set is decided — `call` derives both the refusal and the `--list`
 * exclusion from it.
 */
export const CLI_OWNED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  index_codebase: "tea-rags index-codebase",
  list_projects: "tea-rags projects list",
  register_project: "tea-rags projects register",
  unregister_project: "tea-rags projects unregister",
});

/** The dedicated CLI command for `tool`, or `undefined` when `call` may run it. */
export function cliCommandForTool(tool: string): string | undefined {
  return Object.hasOwn(CLI_OWNED_TOOLS, tool) ? CLI_OWNED_TOOLS[tool] : undefined;
}
