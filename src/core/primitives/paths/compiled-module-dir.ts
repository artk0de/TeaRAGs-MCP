/**
 * Directory holding the COMPILED counterpart of a module, for locating worker
 * scripts that `worker_threads` / `fork` can only load as compiled `.js`.
 *
 * - `.ts` module (vitest / tsx run from `src/`): dirname with the LAST
 *   `<sep>src<sep>` segment remapped to `<sep>build<sep>`. The last segment is
 *   the repo's own `src/`; an earlier one belongs to the install location
 *   (`~/.tea-rags/src/<clone>`, `/home/u/src/node_modules/...`).
 * - Anything else (compiled `.js` already in `build/`): dirname unchanged.
 *
 * Both `/` and `\` separators are honoured, whichever the path carries.
 *
 * @param moduleFilePath absolute module path, already `fileURLToPath`-ed
 */
export function compiledModuleDir(moduleFilePath: string): string {
  const sep = moduleFilePath.includes("\\") && !moduleFilePath.includes("/") ? "\\" : "/";
  const dir = moduleFilePath.slice(0, Math.max(0, moduleFilePath.lastIndexOf(sep)));
  if (!moduleFilePath.endsWith(".ts")) return dir;

  const srcSegment = `${sep}src${sep}`;
  const at = `${dir}${sep}`.lastIndexOf(srcSegment);
  if (at === -1) return dir;
  return `${dir.slice(0, at)}${sep}build${sep}${dir.slice(at + srcSegment.length)}`.replace(/[\\/]$/, "");
}
