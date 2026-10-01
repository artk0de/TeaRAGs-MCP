/**
 * Which test files may run without per-file module isolation (bd tea-rags-mcp-bbo1h.6).
 *
 * vitest.config.ts runs the files this module lists in a project with
 * `isolate: false`: a worker then reuses ONE module registry for every file it
 * runs instead of re-importing the whole graph per file — measured 138s → 54s on
 * the candidate set. The price is that module state outlives the file that set
 * it. So any file that mocks or re-imports modules, stubs env or globals, fakes
 * timers, mutates process-wide state, or spawns processes/workers (whose
 * lifecycle and module-level pools leak into the next file) stays in the
 * isolated project. The screen is purely textual and conservative: a match
 * anywhere in the source — even in a comment — isolates the file, and a new
 * test file is classified the moment it exists, with no hand-kept list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const TEST_MODULE_ISOLATION_RULES: readonly RegExp[] = [
  /\bvi\.(mock|doMock|unmock|doUnmock|hoisted|stubEnv|stubGlobal|useFakeTimers|resetModules|importActual|importMock)\b/,
  /process\.env(\.\w+|\[[^\]]+\])\s*=(?!=)/,
  /delete\s+process\.env/,
  /process\.(chdir|exit|on\(|once\()/,
  // Redefining a process property (e.g. `process.cwd` redirected to a temp
  // root) outlives the file if a test dies before restoring it.
  /defineProperty\(\s*process\b/,
  /child_process|execFileSync|execSync|spawnSync|\bfork\(|\bspawn\(/,
  /ChunkerPool|ProcessTransport|worker_threads|new Worker\(/,
  /globalThis\.\w+\s*=(?!=)/,
  /setDebug\(/,
  /installTestFileConventions/,
];

export function requiresModuleIsolation(source: string): boolean {
  return TEST_MODULE_ISOLATION_RULES.some((rule) => rule.test(source));
}

/** Root-relative, `/`-separated, sorted paths of the `*.test.ts` files under `testDir` that may share modules. */
export function listModuleSharingTestFiles(root: string, testDir: string): string[] {
  const entries = readdirSync(join(root, testDir), { recursive: true, encoding: "utf8" });
  return entries
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => join(testDir, entry))
    .filter((path) => !requiresModuleIsolation(readFileSync(join(root, path), "utf8")))
    .map((path) => path.split(sep).join("/"))
    .sort();
}
