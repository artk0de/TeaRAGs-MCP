/**
 * `tea-rags project indexed` (bd tea-rags-mcp-ueplg): exit 0 when a file — a
 * `--path`, or a reader operand of a `--command` (`cat` / `sed` / `head` /
 * `tail` / `less` / `more`) — is in the index snapshot serving its working
 * tree; 1 when none is; 2 on a usage error. The plugin's PreToolUse hooks run
 * it on every `Read` and every file-reading Bash command, so
 * `src/cli/index.ts` dispatches it through {@link runProjectIndexedArgv}
 * before yargs and the command table load; this module imports the lean
 * bootstrap seam only.
 */

import { parseArgs } from "node:util";

import { findFirstIndexedFileInAppData, type IndexedFileMatch } from "../../bootstrap/indexed-file.js";
import { shellReadOperands } from "./shell-read-operands.js";

export interface ProjectIndexedArgs {
  paths: string[];
  /** A shell command whose reader operands are checked too. */
  command?: string;
  /** Directory `command`'s relative operands resolve against (default: cwd). */
  cwd?: string;
  json?: boolean;
}

export interface ProjectIndexedDeps {
  findFirstIndexedFile: (paths: readonly string[]) => Promise<IndexedFileMatch | null>;
}

const DEFAULT_DEPS: ProjectIndexedDeps = { findFirstIndexedFile: findFirstIndexedFileInAppData };

/** Answers the first indexed file among the args on stdout and returns the exit code. */
export async function runProjectIndexed(
  args: ProjectIndexedArgs,
  deps: ProjectIndexedDeps = DEFAULT_DEPS,
): Promise<number> {
  const operands = args.command === undefined ? [] : (shellReadOperands(args.command, args.cwd ?? process.cwd()) ?? []);
  const paths = [...args.paths, ...operands];
  const match = paths.length > 0 ? await deps.findFirstIndexedFile(paths) : null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify(match ? { indexed: true, ...match } : { indexed: false })}\n`);
  } else if (match) {
    process.stdout.write(`${match.relativePath}\n`);
  }
  return match ? 0 : 1;
}

/** {@link runProjectIndexed} over the raw argv after `project indexed`; exit 2 on a usage error. */
export async function runProjectIndexedArgv(
  argv: readonly string[],
  deps: ProjectIndexedDeps = DEFAULT_DEPS,
): Promise<number> {
  let values: { path?: string[]; command?: string; cwd?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        path: { type: "string", multiple: true },
        command: { type: "string" },
        cwd: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    return 2;
  }
  if (!values.path?.length && values.command === undefined) return 2;
  return runProjectIndexed(
    { paths: values.path ?? [], command: values.command, cwd: values.cwd, json: values.json },
    deps,
  );
}
