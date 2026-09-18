/**
 * Go build constraints — which of a package's build-tag twins the DEFAULT build
 * compiles (bd tea-rags-mcp-e6xx).
 *
 * gin declares `validate` twice in package `binding`: `binding.go` under
 * `//go:build !nomsgpack` and `binding_nomsgpack.go` under `//go:build
 * nomsgpack`. Exactly one compiles in any build, so to the compiler the pair is
 * no ambiguity at all; to a name-keyed symbol table it is two candidates, and
 * every `validate(obj)` stayed unresolved. The walker records each file's
 * `//go:build` expression (`FileExtraction.buildConstraint`, run-global as
 * `CallContext.buildConstraintsByFile`); this module evaluates it, together
 * with the GOOS / GOARCH a file NAME implies (`open_linux.go`,
 * `open_darwin_arm64.go`), under the default tag set.
 *
 * The default tag set, and the one approximation in it: no custom tags (`go
 * build` with no `-tags`), the release tags (`go1.N`), `gc`, `cgo` (the go
 * tool's default for a native build with a C toolchain), and the GOOS / GOARCH
 * of the HOST running the index — `unix` included for a Unix GOOS. A project
 * indexed on macOS therefore prefers its `_darwin` twin; a twin set that only
 * GOOS or GOARCH tells apart names a platform, not "the" build, and the host's
 * is as good a representative as any. The approximation moves no edge between
 * gin's twins, which are told apart by a custom tag.
 *
 * `preferGoDefaultBuild` is a TIE-BREAKER only. It narrows a candidate list
 * whose members all sit in ONE package directory and ALL carry a constraint —
 * valid Go cannot declare one name twice in a package unless constraints keep
 * the two apart, so a candidate without one (or one this run never walked,
 * whose `//go:build` line is unknown) means the list is not a twin set, and it
 * is returned untouched. It keeps exactly the one candidate whose file the
 * default build compiles, or none.
 */

import { posix } from "node:path";

import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";

/** The GOOS / GOARCH a build is for. */
export interface GoBuildContext {
  readonly goos: string;
  readonly goarch: string;
}

/** `go tool dist list` operating systems (`go/build` `knownOS`). */
const GO_KNOWN_OS: ReadonlySet<string> = new Set([
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "js",
  "linux",
  "nacl",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "wasip1",
  "windows",
  "zos",
]);

/** `go/build` `knownArch`. */
const GO_KNOWN_ARCH: ReadonlySet<string> = new Set([
  "386",
  "amd64",
  "amd64p32",
  "arm",
  "armbe",
  "arm64",
  "arm64be",
  "loong64",
  "mips",
  "mipsle",
  "mips64",
  "mips64le",
  "mips64p32",
  "mips64p32le",
  "ppc",
  "ppc64",
  "ppc64le",
  "riscv",
  "riscv64",
  "s390",
  "s390x",
  "sparc",
  "sparc64",
  "wasm",
]);

/** GOOS values the `unix` build tag holds for (`go/build` `unixOS`). */
const GO_UNIX_OS: ReadonlySet<string> = new Set([
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "linux",
  "netbsd",
  "openbsd",
  "solaris",
]);

/** Tags a GOOS implies besides its own name (`android` builds `linux` files, …). */
const GO_IMPLIED_OS_TAGS: Readonly<Record<string, string>> = { android: "linux", ios: "darwin", illumos: "solaris" };

/** Tags every default build sets, whatever the platform. */
const GO_DEFAULT_TOOLCHAIN_TAGS: ReadonlySet<string> = new Set(["gc", "cgo"]);

const GO_RELEASE_TAG = /^go1\.\d+$/;

/** Node's `process.platform` / `process.arch` spelled as GOOS / GOARCH. */
const NODE_PLATFORM_TO_GOOS: Readonly<Record<string, string>> = { win32: "windows", sunos: "solaris" };
const NODE_ARCH_TO_GOARCH: Readonly<Record<string, string>> = {
  x64: "amd64",
  ia32: "386",
  ppc64: "ppc64le",
  mipsel: "mipsle",
};

/** The build context of a Node platform / arch pair. */
export function goBuildContextForHost(platform: string, arch: string): GoBuildContext {
  return { goos: NODE_PLATFORM_TO_GOOS[platform] ?? platform, goarch: NODE_ARCH_TO_GOARCH[arch] ?? arch };
}

/** The build context of the host running the index — the default build's GOOS / GOARCH. */
export const GO_HOST_BUILD_CONTEXT: GoBuildContext = goBuildContextForHost(process.platform, process.arch);

function tagHolds(tag: string, context: GoBuildContext): boolean {
  if (tag === context.goos || tag === context.goarch) return true;
  if (GO_IMPLIED_OS_TAGS[context.goos] === tag) return true;
  if (tag === "unix") return GO_UNIX_OS.has(context.goos);
  return GO_DEFAULT_TOOLCHAIN_TAGS.has(tag) || GO_RELEASE_TAG.test(tag);
}

/**
 * Whether the GOOS / GOARCH a file name implies hold — `go/build`'s
 * `goodOSArchFile`: after the extension and a `_test` suffix are stripped, the
 * name's last `_`-separated elements past the first are `…_GOOS_GOARCH`,
 * `…_GOOS` or `…_GOARCH`. `undefined` when the name implies nothing.
 */
function filenameConstraintHolds(relPath: string, context: GoBuildContext): boolean | undefined {
  const name = posix.basename(relPath, ".go");
  const underscore = name.indexOf("_");
  if (underscore < 0) return undefined;
  const parts = name.slice(underscore).split("_");
  if (parts[parts.length - 1] === "test") parts.pop();
  const last = parts[parts.length - 1];
  const previous = parts[parts.length - 2];
  if (parts.length >= 2 && previous !== undefined && GO_KNOWN_OS.has(previous) && GO_KNOWN_ARCH.has(last)) {
    return tagHolds(previous, context) && tagHolds(last, context);
  }
  if (GO_KNOWN_OS.has(last) || GO_KNOWN_ARCH.has(last)) return tagHolds(last, context);
  return undefined;
}

/** `||` / `&&` / `!` / parentheses over tags — the `//go:build` grammar. */
function evaluateBuildExpression(expression: string, context: GoBuildContext): boolean | undefined {
  const tokens = expression.match(/\|\||&&|!|\(|\)|[\p{L}\p{N}_.]+|\S/gu) ?? [];
  let at = 0;
  const parseOr = (): boolean | undefined => {
    let value = parseAnd();
    while (value !== undefined && tokens[at] === "||") {
      at++;
      const right = parseAnd();
      value = right === undefined ? undefined : value || right;
    }
    return value;
  };
  const parseAnd = (): boolean | undefined => {
    let value = parseNot();
    while (value !== undefined && tokens[at] === "&&") {
      at++;
      const right = parseNot();
      value = right === undefined ? undefined : value && right;
    }
    return value;
  };
  const parseNot = (): boolean | undefined => {
    if (tokens[at] === "!") {
      at++;
      const operand = parseNot();
      return operand === undefined ? undefined : !operand;
    }
    return parseAtom();
  };
  const parseAtom = (): boolean | undefined => {
    const token = tokens[at];
    if (token === undefined) return undefined;
    if (token === "(") {
      at++;
      const inner = parseOr();
      if (tokens[at] !== ")") return undefined;
      at++;
      return inner;
    }
    if (!/^[\p{L}\p{N}_.]+$/u.test(token)) return undefined;
    at++;
    return tagHolds(token, context);
  };
  const value = parseOr();
  return at === tokens.length ? value : undefined;
}

/**
 * Whether the default build compiles the file: its name's GOOS / GOARCH and
 * its `//go:build` expression, both where present. `undefined` when the file
 * carries neither, or the expression does not parse — nothing to decide on.
 */
export function goFileBuildsByDefault(
  relPath: string,
  buildExpression: string | undefined,
  context: GoBuildContext,
): boolean | undefined {
  const byName = filenameConstraintHolds(relPath, context);
  const byLine = buildExpression === undefined ? undefined : evaluateBuildExpression(buildExpression, context);
  if (buildExpression !== undefined && byLine === undefined) return undefined;
  if (byName === undefined) return byLine;
  return byLine === undefined ? byName : byName && byLine;
}

/**
 * Narrow same-package build-tag twins to the one the default build compiles,
 * else return `candidates` untouched (see the module docblock).
 */
export function preferGoDefaultBuild(
  candidates: SymbolDefinition[],
  ctx: CallContext,
  context: GoBuildContext = GO_HOST_BUILD_CONTEXT,
): SymbolDefinition[] {
  if (candidates.length < 2) return candidates;
  const packageDir = posix.dirname(candidates[0].relPath);
  if (candidates.some((def) => posix.dirname(def.relPath) !== packageDir)) return candidates;
  const kept: SymbolDefinition[] = [];
  for (const def of candidates) {
    const builds = goFileBuildsByDefault(def.relPath, ctx.buildConstraintsByFile?.[def.relPath], context);
    if (builds === undefined) return candidates;
    if (builds) kept.push(def);
  }
  return kept.length === 1 ? kept : candidates;
}
