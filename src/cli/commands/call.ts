/**
 * `tea-rags call <tool> [params]` — invoke one MCP tool in-process (bd
 * tea-rags-mcp-8vy3o).
 *
 * The tool runs on the MCP server `tea-rags server` would serve, reached by an
 * SDK client over the in-memory transport — zod input validation, schema
 * defaults, the error middleware and the formatters are the ones a real client
 * sees. The point is live validation of the tool surface against the CURRENT
 * build (`node build/cli/index.js call …`) with no server reconnect.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CommandModule } from "yargs";
import { hideBin } from "yargs/helpers";

import { openInProcessMcpSession } from "../../bootstrap/in-process-session.js";
import type { InProcessToolSession } from "../../bootstrap/transport/in-memory.js";
import { resolveBaseIndexEntry } from "../../core/api/index.js";
import { CLI_OWNED_TOOLS, cliCommandForTool } from "../call/cli-owned-tools.js";
import { prepareCallProjectEnv } from "../call/project-env.js";
import { rememberCallToolNames } from "../call/tool-name-cache.js";

export interface CallArgs {
  tool?: string;
  /** JSON object string, or `-` to read it from stdin. */
  params?: string;
  list?: boolean;
  json?: boolean;
}

export interface CallDeps {
  openSession: () => Promise<InProcessToolSession>;
  readStdin: () => Promise<string>;
  /** One stdout write (a newline is appended). */
  out: (text: string) => void;
  /** One stderr write (a newline is appended). */
  errOut: (text: string) => void;
  rememberToolNames?: (names: string[]) => void;
  /**
   * Replay the target project's registry env before the server is built (bd
   * tea-rags-mcp-nxwsq). Receives the parsed tool params (`{}` for a listing)
   * — the fields a tool addresses its project by.
   */
  prepareProjectEnv?: (params: Record<string, unknown>) => Promise<void>;
}

/** Exit codes of `tea-rags call`. */
export const CALL_EXIT_CODES = {
  ok: 0,
  /** The tool reported an error (`isError`), or input / params were invalid. */
  failed: 1,
  /** No such tool here: unknown, gated off, or owned by a dedicated CLI command. */
  notCallable: 2,
} as const;

type CallErrorCode = "INVALID_JSON" | "UNKNOWN_TOOL" | "CLI_OWNED_TOOL" | "CALL_FAILED";

const MAX_SUGGESTIONS = 5;
const DESCRIPTION_WIDTH = 110;

export async function runCall(args: CallArgs, deps: CallDeps): Promise<number> {
  if (args.list === true || args.tool === undefined || args.tool === "") {
    return listTools(args, deps);
  }
  const { tool } = args;

  const command = cliCommandForTool(tool);
  if (command !== undefined) {
    return fail(deps, args, CALL_EXIT_CODES.notCallable, {
      code: "CLI_OWNED_TOOL",
      message: `"${tool}" is served by a dedicated CLI command — run \`${command}\` instead.`,
      command,
    });
  }

  const parsed = parseParams(args.params === "-" ? await deps.readStdin() : args.params);
  if (!parsed.ok) {
    return fail(deps, args, CALL_EXIT_CODES.failed, { code: "INVALID_JSON", message: parsed.message });
  }

  return withSession(deps, args, parsed.value, async (session) => {
    const tools = await callableTools(session, deps);
    if (!tools.some((t) => t.name === tool)) {
      const suggestions = closeMatches(
        tool,
        tools.map((t) => t.name),
      );
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      return fail(deps, args, CALL_EXIT_CODES.notCallable, {
        code: "UNKNOWN_TOOL",
        message: `Unknown tool "${tool}".${hint} Run \`tea-rags call --list\` for the callable set.`,
        suggestions,
      });
    }

    const result = await session.callTool(tool, parsed.value);
    const exitCode = result.isError === true ? CALL_EXIT_CODES.failed : CALL_EXIT_CODES.ok;
    if (args.json === true) {
      deps.out(JSON.stringify(result));
    } else {
      const sink = result.isError === true ? deps.errOut : deps.out;
      for (const text of renderContent(result)) sink(text);
    }
    return exitCode;
  });
}

async function listTools(args: CallArgs, deps: CallDeps): Promise<number> {
  return withSession(deps, args, {}, async (session) => {
    const tools = await callableTools(session, deps);
    const cliOwned = Object.entries(CLI_OWNED_TOOLS).map(([name, command]) => ({ name, command }));
    if (args.json === true) {
      deps.out(JSON.stringify({ tools: tools.map((t) => ({ name: t.name, description: oneLine(t) })), cliOwned }));
      return CALL_EXIT_CODES.ok;
    }
    const width = Math.max(0, ...tools.map((t) => t.name.length));
    for (const t of tools) deps.out(`${t.name.padEnd(width)}  ${oneLine(t)}`);
    deps.errOut(`Served by dedicated CLI commands: ${cliOwned.map((o) => `${o.name} → ${o.command}`).join(", ")}`);
    return CALL_EXIT_CODES.ok;
  });
}

/** The server's tools minus the CLI-owned ones, sorted; also recorded for completion. */
async function callableTools(session: InProcessToolSession, deps: CallDeps): Promise<Tool[]> {
  const tools = (await session.listTools())
    .filter((t) => cliCommandForTool(t.name) === undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  deps.rememberToolNames?.(tools.map((t) => t.name));
  return tools;
}

async function withSession(
  deps: CallDeps,
  args: CallArgs,
  params: Record<string, unknown>,
  body: (session: InProcessToolSession) => Promise<number>,
): Promise<number> {
  let session: InProcessToolSession | undefined;
  try {
    // The server's gating and config are parsed from env at open — the
    // project's registry env has to be in place first.
    await deps.prepareProjectEnv?.(params);
    session = await deps.openSession();
    return await body(session);
  } catch (error) {
    // Not a tool error — those come back as `isError` results. This is the
    // server failing to start (Qdrant unreachable, bad config) or the
    // transport failing mid-request.
    return fail(deps, args, CALL_EXIT_CODES.failed, {
      code: "CALL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await session?.close();
  }
}

function fail(
  deps: CallDeps,
  args: CallArgs,
  exitCode: number,
  error: { code: CallErrorCode; message: string } & Record<string, unknown>,
): number {
  if (args.json === true) deps.out(JSON.stringify({ error }));
  else deps.errOut(error.message);
  return exitCode;
}

/**
 * The `params` positional as the user typed it. yargs re-parses command
 * positionals as `--params <value>`, and a bare `-` is not taken as a value
 * there — it arrives as `""` (or `true`) and the stdin marker is lost. The raw
 * argv tokens still hold it, so a mangled value plus a standalone `-` token
 * means "read the JSON from stdin".
 */
export function resolveParamsArg(parsed: unknown, rawTokens: readonly string[]): string | undefined {
  if (typeof parsed === "string" && parsed !== "") return parsed;
  return rawTokens.includes("-") ? "-" : undefined;
}

type ParsedParams = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

function parseParams(raw: string | undefined): ParsedParams {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      message: `params is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: 'params must be a JSON object, e.g. \'{"project":"my-app"}\'.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * What an agent reads. Search tools answer with `structuredContent` and an
 * empty (or hint-only) `content`, so the structured payload comes first,
 * pretty-printed; then text blocks verbatim; any other block type is named
 * and deferred to `--json`.
 */
function renderContent(result: CallToolResult): string[] {
  const structured = result.structuredContent === undefined ? [] : [JSON.stringify(result.structuredContent, null, 2)];
  const blocks = result.content.map((block) =>
    block.type === "text" ? block.text : `[${block.type} content omitted — rerun with --json]`,
  );
  return [...structured, ...blocks];
}

/** First line / sentence of a tool description, clipped for a one-line listing. */
function oneLine(tool: Tool): string {
  const text = (tool.description ?? tool.title ?? "").trim();
  const firstLine = text.split("\n", 1)[0] ?? "";
  const sentenceEnd = firstLine.search(/\.(\s|$)/);
  const sentence = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
  return sentence.length > DESCRIPTION_WIDTH ? `${sentence.slice(0, DESCRIPTION_WIDTH - 1)}…` : sentence;
}

/** Candidates within a small edit distance of `name`, or containing / contained by it. */
function closeMatches(name: string, candidates: readonly string[]): string[] {
  const threshold = Math.max(2, Math.floor(name.length / 3));
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter(({ candidate, distance }) => distance <= threshold || candidate.includes(name) || name.includes(candidate))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ candidate }) => candidate);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length];
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Keep stdout for the tool's answer alone: anything the in-process server
 * logs through `console.log/info/debug` goes to stderr for the duration — the
 * same contract the stdio transport already imposes on the server.
 */
function routeConsoleToStderr(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

/** Resolves once everything written to `stream` so far has been flushed. */
async function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}

export const callCommand: CommandModule<object, CallArgs> = {
  command: "call [tool] [params]",
  describe: "Invoke an MCP tool in-process on the current build (live validation of the tool surface)",
  builder: (yargs) =>
    yargs
      .positional("tool", { type: "string", describe: "MCP tool name. Omit (or pass --list) to list callable tools." })
      .positional("params", {
        type: "string",
        describe: "Tool arguments as a JSON object string, or `-` to read the JSON from stdin",
      })
      .option("list", { type: "boolean", default: false, describe: "List callable tools with a one-line description" })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print the full CallToolResult (content, structuredContent, isError) as one JSON document",
      })
      .example('$0 call find_symbol \'{"project":"my-app","symbol":"Reranker#rerank"}\'', "")
      .example('echo \'{"project":"my-app"}\' | $0 call get_index_status - --json', "")
      .epilog(
        "Exit codes: 0 success; 1 tool error, invalid input or invalid params JSON; 2 unknown tool or a tool " +
          "served by a dedicated CLI command. The server is built from the current config exactly as " +
          "`tea-rags server` builds it, except that search tools never trigger a background auto-update.",
      ),
  handler: async (argv) => {
    const restoreConsole = routeConsoleToStderr();
    let exitCode: number;
    try {
      exitCode = await runCall(
        {
          tool: argv.tool,
          params: resolveParamsArg(argv.params, hideBin(process.argv)),
          list: argv.list,
          json: argv.json,
        },
        {
          openSession: openInProcessMcpSession,
          readStdin: readAllStdin,
          out: (text) => process.stdout.write(`${text}\n`),
          errOut: (text) => process.stderr.write(`${text}\n`),
          rememberToolNames: (names) => {
            rememberCallToolNames(names);
          },
          // The command is the composition actor (bd tea-rags-mcp-nkstp): it
          // holds the api assembly seam and passes the path→entry capability
          // down; the project-env leaf holds no barrel edge of its own.
          prepareProjectEnv: async (params) => prepareCallProjectEnv(params, resolveBaseIndexEntry),
        },
      );
    } finally {
      restoreConsole();
    }
    // Exit explicitly: a one-shot call must not wait on handles a long-lived
    // server keeps (registry watcher, pooled sockets). Flush first — stdout to
    // a pipe is asynchronous on macOS, and a large --json answer would be cut.
    await flushed(process.stdout);
    await flushed(process.stderr);
    process.exit(exitCode);
  },
};
