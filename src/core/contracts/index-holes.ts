/**
 * The one-line warning for files the sync snapshot lists as indexed that hold
 * no points (bd tea-rags-mcp-muj77). Shared by `get_index_status` and the prime
 * digest so both surfaces say the same thing and name the same remedy: those
 * files carry a valid snapshot hash, so only a force re-index re-judges them.
 */
export function formatIndexHolesLine(count: number): string {
  return `⚠ index holes: ${count} files in snapshot without points — re-index them: index_codebase forceReindex=true`;
}
