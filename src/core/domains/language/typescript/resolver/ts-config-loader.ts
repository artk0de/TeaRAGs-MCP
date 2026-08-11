/**
 * Loads `compilerOptions.{baseUrl, paths}` from the repository's
 * `tsconfig.json` — the mapping every import in the project resolves through.
 *
 * ## Why the compiler's own parser, and not `JSON.parse`
 *
 * A tsconfig is JSONC, and comments are only half of what that allows. This
 * loader used to strip `/* *\/` and `//` and hand the rest to `JSON.parse`,
 * which still rejects trailing commas — and the `catch` returned
 * `{ baseUrl: ".", paths: {} }` without a word.
 *
 * That is not a hypothetical rough edge. taxdome's `tsconfig.json` carries a
 * trailing comma inside `compilerOptions.paths`, so the loader silently handed
 * the resolver an empty mapping, and 107 896 of that project's 111 057 import
 * specifiers (97.2%) are non-relative and therefore resolve through `paths`.
 * Every one of them mapped to nothing. `targetsExternalImport` reads an
 * unmappable specifier as "this call leaves the project", so 78 259 of 189 630
 * call sites were struck from the `resolveSuccessRate` denominator as external,
 * and the reported rate was computed over what was left (bd tea-rags-mcp-t6ycg).
 *
 * `ts.readConfigFile` is the parser the compiler uses on this exact file
 * format, so the format can never drift out from under us again.
 *
 * ## `extends`
 *
 * `ts.parseJsonConfigFileContent` resolves the `extends` chain as part of the
 * same call, so inheriting `paths` from a base config costs nothing extra. The
 * glob expansion it would otherwise do is suppressed — `readDirectory` returns
 * nothing, because this loader wants two option fields and not a file list, and
 * expanding `include` over a 16 000-file repo on every resolver construction is
 * pure waste. The one diagnostic that suppression provokes (TS18003, "no inputs
 * were found") is expected and filtered; anything else is reported.
 *
 * ## The `baseUrl` contract: repo-relative, never absolute, never empty
 *
 * Both consumers want a repo-relative value — `mapImportToFile` does
 * `posix.join(baseUrl, target)` and `TSProgramCache` does
 * `resolve(repoRoot, baseUrl || ".")` — while the compiler resolves `baseUrl`
 * to an ABSOLUTE path. So it is converted back here, in one place. `"."` rather
 * than `""` when it lands on the repo root itself: `resolve(repoRoot, "")` is
 * the process cwd, which would retarget every Program the cache builds.
 *
 * Boundary: when `paths` is inherited from a config in a DIFFERENT directory
 * and declares no `baseUrl`, TypeScript resolves those targets against the
 * declaring config's directory, while this falls back to the root config's.
 * Same directory — the ordinary monorepo `extends "./tsconfig.base.json"` — is
 * exact; the cross-directory case would need `pathsBasePath`, which the public
 * typings do not expose.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import ts from "typescript";

import { isDebug } from "../../../../infra/runtime.js";
import type { TsCompilerOptions } from "./ts-path-mapper.js";

/** No `baseUrl`, no aliases — every non-relative specifier is then external. */
const NO_PATH_MAPPING: TsCompilerOptions = { baseUrl: ".", paths: {} };

/**
 * "No inputs were found in config file" — provoked by this loader's own
 * glob suppression, not by anything wrong with the project's config.
 */
const NO_INPUTS_FOUND_DIAGNOSTIC = 18003;

/**
 * Config host that reads files but never walks directories. `extends` needs
 * `fileExists` / `readFile`; `include` / `exclude` expansion needs
 * `readDirectory`, and that is exactly the work this loader has no use for.
 */
function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const GLOB_FREE_PARSE_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys?.useCaseSensitiveFileNames ?? true,
  readDirectory: () => [],
  fileExists: (path: string): boolean => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readFile: readFileOrUndefined,
};

/**
 * Report a config we could not fully read. Degrading to "no aliases" is the
 * safe direction — an unmapped specifier drops an edge, where a guessed one
 * fabricates it — but it must not be silent: an empty `paths` on a project that
 * relies on aliases looks identical to a project that has none.
 */
function reportDegraded(configPath: string, detail: string): void {
  if (!isDebug()) return;
  console.error(`[TSConfig] ${configPath}: ${detail} — resolving without path aliases`);
}

/** The compiler's absolute `baseUrl`, expressed the way both consumers read it. */
function toRepoRelativeBaseUrl(repoRoot: string, absoluteBase: string): string {
  const rel = relative(repoRoot, absoluteBase);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return ".";
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export function loadTsConfig(repoRoot: string): TsCompilerOptions {
  const configPath = join(repoRoot, "tsconfig.json");
  if (!existsSync(configPath)) return NO_PATH_MAPPING;

  const read = ts.readConfigFile(configPath, readFileOrUndefined);
  if (read.error !== undefined || read.config === undefined) {
    const detail =
      read.error === undefined ? "unreadable" : ts.flattenDiagnosticMessageText(read.error.messageText, " ");
    reportDegraded(configPath, detail);
    return NO_PATH_MAPPING;
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, GLOB_FREE_PARSE_HOST, repoRoot, undefined, configPath);
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code === NO_INPUTS_FOUND_DIAGNOSTIC) continue;
    reportDegraded(configPath, ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  }

  const { baseUrl, paths } = parsed.options;
  return {
    baseUrl: toRepoRelativeBaseUrl(repoRoot, baseUrl ?? dirname(configPath)),
    paths: paths ?? {},
  };
}
