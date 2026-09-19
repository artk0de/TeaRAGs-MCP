/**
 * Go's module manifest (bd tea-rags-mcp-e6xx) — which file declares a module
 * and how to read its path out of one. Pure: the directory walk that finds the
 * files is infra's (`infra/dependency-manifests.ts#readManifestFiles`), the
 * same split Python's `manifest.ts` keeps with `readDeclaredDependencies`.
 *
 * Deliberately NOT a `DependencyManifestSource`. That facility unions declared
 * dependency NAMES into the run-global set the Python vocabulary gate reads,
 * and "a manifest was found" flips that gate from all-on to gated. A `go.mod`
 * in a Python repository with no Python manifest would switch every Python
 * framework vocabulary off — and the fact a Go resolver needs is not a name at
 * all but a module path bound to the directory the file sits in.
 */

/** The one file name that declares a Go module. */
export const GO_MODULE_MANIFEST_FILE = "go.mod";

/**
 * Directories the go.mod walk skips on top of the shared manifest walk's own
 * ignore list (bd tea-rags-mcp-e6xx). `vendor/`: `go mod vendor` under a go
 * directive below 1.17 copies every dependency's go.mod there, and the module
 * map would read each as a project module. It is Go's alone — the shared list
 * also serves Python's dependency walk, which reads `vendor/` as it always has.
 */
export const GO_MODULE_WALK_IGNORED_DIRS: ReadonlySet<string> = new Set(["vendor"]);

/**
 * The module path of a `go.mod`, or `undefined` when it has no `module`
 * directive. Handles a quoted path and a trailing `//` comment; the manifest
 * is not source code, so a line scan is the parser (`go mod edit -json` is the
 * only other one, and it needs a toolchain).
 */
export function parseGoModulePath(content: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const match = /^module\s+(\S+)$/.exec(line);
    if (match) return match[1].replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}
