/**
 * `tea-rags resource <uri>` — read one MCP resource in-process, the resource
 * twin of `tea-rags call`: same server build, same in-memory transport. Lets a
 * harness without MCP resource support (or a hook) pull `tea-rags://` docs.
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommandModule } from "yargs";

import type { InProcessToolSession } from "../../bootstrap/transport/in-memory.js";
import { openInProcessMcpSession } from "../../bootstrap/transport/in-process-session.js";
import { resolveBaseIndexEntry, resolveRegistryEnv } from "../../core/api/index.js";
import { prepareCallProjectEnv } from "../call/project-env.js";
import { flushed, routeConsoleToStderr } from "../call/stdio.js";
import { createCollectionRegistry, resolveProjectAlias } from "./project.js";

/** Placeholder in `<uri>` replaced by the resolved project alias. */
const ALIAS_PLACEHOLDER = "{alias}";

export interface RunResourceArgs {
  uri?: string;
  /** Project dir the alias is resolved from (default cwd). */
  path?: string;
  /** Project alias; wins over `path`. */
  project?: string;
  json?: boolean;
  /** Print every resource URI and template URI instead of reading one. */
  list?: boolean;
  /** Injected for tests; production opens the in-process server. */
  session?: InProcessToolSession;
  resolveAlias?: (input: { path?: string; project?: string }) => Promise<string | null>;
  /** One stdout write (a newline is appended). */
  out?: (text: string) => void;
  /** One stderr write (a newline is appended). */
  errOut?: (text: string) => void;
}

const LIST_HINT = "Run `tea-rags resource --list` for the readable set.";

export async function runResource(input: RunResourceArgs): Promise<number> {
  const out = input.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const errOut = input.errOut ?? ((text: string) => process.stderr.write(`${text}\n`));

  if (input.list !== true && !input.uri) {
    errOut(`No resource URI given. ${LIST_HINT}`);
    return 1;
  }

  let alias: string | null = null;
  if (input.list !== true && input.uri?.includes(ALIAS_PLACEHOLDER)) {
    const resolveAlias = input.resolveAlias ?? (async (target) => resolveProjectAlias(target));
    alias = await resolveAlias({ path: input.path, project: input.project });
    if (alias === null) {
      const target = input.project ? `alias "${input.project}"` : `path ${input.path ?? process.cwd()}`;
      errOut(`No registered project for ${target}; register the project: tea-rags index-codebase --name <alias>`);
      return 1;
    }
  }

  let session: InProcessToolSession | undefined;
  try {
    session = input.session ?? (await openResourceSession(alias, input));
    if (input.list === true) {
      for (const resource of await session.listResources()) out(resource.uri);
      for (const template of await session.listResourceTemplates()) out(template.uriTemplate);
      return 0;
    }
    const uri = alias === null ? (input.uri ?? "") : (input.uri ?? "").replaceAll(ALIAS_PLACEHOLDER, alias);
    const result = await session.readResource(uri);
    if (input.json === true) {
      out(JSON.stringify(result));
    } else {
      printContents(result, out, errOut);
    }
    return 0;
  } catch (error) {
    // Unknown URI, a failing resource handler, or the server failing to start.
    errOut(`${error instanceof Error ? error.message : String(error)}\n${LIST_HINT}`);
    return 1;
  } finally {
    await session?.close();
  }
}

function printContents(
  readResourceResult: ReadResourceResult,
  out: (text: string) => void,
  errOut: (text: string) => void,
): void {
  for (const content of readResourceResult.contents) {
    if ("text" in content && typeof content.text === "string") {
      out(content.text);
    } else {
      errOut(`${content.uri}: binary ${content.mimeType ?? "content"} — use --json`);
    }
  }
}

/**
 * The server parses its config from env at open — replay the target project's
 * registry env first, as `tea-rags call` does.
 */
async function openResourceSession(alias: string | null, input: RunResourceArgs): Promise<InProcessToolSession> {
  const params: Record<string, unknown> = {};
  const project = alias ?? input.project;
  if (project) params.project = project;
  else if (input.path) params.path = input.path;
  await prepareCallProjectEnv(params, resolveBaseIndexEntry, {
    registry: createCollectionRegistry(),
    resolveEnv: resolveRegistryEnv,
  });
  return openInProcessMcpSession();
}

interface ResourceArgs {
  uri?: string;
  path?: string;
  project?: string;
  json?: boolean;
  list?: boolean;
}

export const resourceCommand: CommandModule<object, ResourceArgs> = {
  command: "resource [uri]",
  describe: "Read MCP resource in-process (tea-rags:// docs, schemas, project data)",
  builder: (yargs) =>
    yargs
      .positional("uri", { type: "string", describe: "Resource URI; literal {alias} → resolved project alias" })
      .option("path", { type: "string", describe: "Project dir for {alias} (default cwd)" })
      .option("project", { type: "string", describe: "Project alias for {alias}; wins over --path" })
      .option("json", { type: "boolean", default: false, describe: "Print raw ReadResourceResult JSON" })
      .option("list", { type: "boolean", default: false, describe: "List resource URIs + template URIs" })
      .example("$0 resource tea-rags://guide/filters", "")
      .example("$0 resource 'tea-rags://project/{alias}/digest' --path .", "")
      .epilog("Exit codes: 0 success; 1 unknown resource, unresolvable alias or server failure."),
  handler: async (argv) => {
    const restoreConsole = routeConsoleToStderr();
    let exitCode: number;
    try {
      exitCode = await runResource({
        uri: argv.uri,
        path: argv.path,
        project: argv.project,
        json: argv.json,
        list: argv.list,
      });
    } finally {
      restoreConsole();
    }
    await flushed(process.stdout);
    await flushed(process.stderr);
    process.exit(exitCode);
  },
};
