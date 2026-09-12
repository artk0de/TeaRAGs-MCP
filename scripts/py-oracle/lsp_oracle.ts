/**
 * The second oracle (bd tea-rags-mcp-w205u, E4.0.2). Same stdin/stdout NDJSON
 * contract as `jedi_oracle.py`, so the host merges per FILE without knowing
 * which engine answered. It exists for ONE population: the files parso 0.8.7
 * cannot read — 20,424 polar rows and 2,331 netbox rows that every published
 * rate has dropped. It is NOT a replacement for jedi, and `--oracle jedi` stays
 * the default.
 *
 * The engine is **pyright 1.1.414**, chosen on measured evidence in spec
 * decision D7: 100.0 % symbol agreement with jedi where both answer in-project
 * (132/132 of a seeded 500-site sample), byte-identical over two runs, 2.2 s
 * per 1k sites. ty 0.0.80 was rejected — it resolved polar's in-repo SDK to the
 * installed `polar_sdk` on 28 of those rows, the duplicate-package trap
 * `order_roots` / `build_sys_path` exist for. The file is named for the
 * TRANSPORT: swapping the engine is a launcher record, not a rewrite.
 *
 * `parsoErrors` is always 0 here: the field means "jedi's parser was unhappy",
 * and this engine has no jedi in it. The host reads the field from the JEDI
 * reply when it decides the fallback, never from this one.
 *
 * Two facts from the spike that are load-bearing and cost measurement to find:
 *
 *   * `workspace/configuration` must be answered PER ITEM, resolving each
 *     item's `section` against the settings tree. A one-element reply leaves
 *     the server on its defaults and drove `unknown` from 8.6 % to 50.4 %.
 *   * every engine's own bundled typeshed needs a marker in `PY_STUB_MARKERS`,
 *     or its stdlib answers read `outsideRepo` and the origin column stops
 *     being comparable with jedi's.
 *
 * Usage (the host spawns it; the arguments come over stdin):
 *   npx tsx scripts/py-oracle/lsp_oracle.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { PYTHON_STDLIB_MODULES } from "../../src/core/domains/language/python/vocabulary/stdlib-modules.js";
import {
  locateCalleeColumn,
  type PyOracleAnswer,
  type PyOracleFileReply,
  type PySiteFacts,
} from "../lib/py-oracle-core.js";
import { classifyOrigin, PY_IN_PROJECT_ORIGINS } from "../lib/py-oracle-origin.js";

/** Pinned and cache-local, exactly as D7 records it. Never installed globally. */
export const PYRIGHT_VERSION = "1.1.414";

/** The config record the host writes as its first stdin line. */
export interface LspOracleConfig {
  corpusRoot: string;
  venvPython: string | null;
  /** Absolute source roots, manifest order — pyright's `extraPaths`. */
  roots: string[];
  /** The manifest's `oraclePython`; pyright's `python.analysis.pythonVersion`. */
  pythonVersion?: string;
}

/** One call site, as the host writes it. `column` is 0-based on `startLine`. */
export interface LspOracleSite {
  startLine: number;
  member: string;
  receiver: string | null;
  callText: string;
  column?: number;
}

export interface LspLauncher {
  command: string[];
  settings: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

/**
 * pyright's launcher and its per-corpus configuration, verbatim from D7:
 * `pythonPath` at the corpus venv, `pythonVersion` at the manifest's
 * `oraclePython`, `extraPaths` at its declared roots, `VIRTUAL_ENV` in the
 * child env. `extraPaths` mirrors the list `build_sys_path` puts ahead of the
 * venv on the jedi side — without it an installed distribution sharing a
 * top-level name with the corpus wins the lookup (7dsyq, 1,610 rows).
 */
export function pyrightLauncher(config: LspOracleConfig, baseEnv: NodeJS.ProcessEnv): LspLauncher {
  const venv = config.venvPython;
  const venvDir = venv === null ? undefined : resolvePath(venv, "..", "..");
  const settings = {
    python: {
      pythonPath: venv ?? "python3",
      venvPath: venvDir === undefined ? undefined : resolvePath(venvDir, ".."),
      venv: venvDir === undefined ? undefined : venvDir.split("/").pop(),
      analysis: {
        typeCheckingMode: "basic",
        diagnosticMode: "openFilesOnly",
        useLibraryCodeForTypes: true,
        autoSearchPaths: true,
        pythonVersion: config.pythonVersion ?? "3.13",
        extraPaths: [...config.roots],
      },
    },
    pyright: { disableLanguageServices: false },
  };
  return {
    command: ["npx", "--yes", "--package", `pyright@${PYRIGHT_VERSION}`, "pyright-langserver", "--stdio"],
    settings,
    env:
      venvDir === undefined
        ? { ...baseEnv }
        : { ...baseEnv, VIRTUAL_ENV: venvDir, PATH: `${venvDir}/bin:${baseEnv.PATH ?? ""}` },
  };
}

const DEF_RE = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DECORATOR_RE = /^\s*@\s*(staticmethod|classmethod)\b/;

/**
 * `compose_symbol_id` (`jedi_oracle.py:98`) over the target file's own text:
 * `Class#method`, `Class.method` behind a `staticmethod` / `classmethod`
 * decorator, a bare name at module level, `Outer.Inner` for nesting.
 *
 * The two failures are DIFFERENT facts and do not share a kind. `unknown` is
 * the target file being unreadable — an instrument gap. `nonCallable` is the
 * line starting no `def` or `class`: an assignment, which is what a goto
 * answers for `table = None` called as `self.table(...)`. Both stay
 * `pinUncertain`; neither can be compared at symbol granularity.
 *
 * A line scan rather than a parse, because the caller memoises by target path
 * exactly as `_cached_tree` does — one read per target file, not one per site.
 */
export function composeSymbolId(
  lines: readonly string[],
  defLine: number,
): { symbolId: string | null; defKind: string; pinUncertain: boolean } {
  const own = lines[defLine - 1];
  if (own === undefined) return { symbolId: null, defKind: "unknown", pinUncertain: true };
  const here = DEF_RE.exec(own);
  if (here === null) return { symbolId: null, defKind: "nonCallable", pinUncertain: true };
  const [, indent, keyword, name] = here;
  const scope: string[] = [];
  let depth = indent.length;
  for (let index = defLine - 2; index >= 0 && depth > 0; index--) {
    const outer = DEF_RE.exec(lines[index] ?? "");
    if (outer === null || outer[1].length >= depth) continue;
    scope.unshift(outer[3]);
    depth = outer[1].length;
  }
  if (keyword === "class") return { symbolId: [...scope, name].join("."), defKind: "class", pinUncertain: false };
  if (scope.length === 0) return { symbolId: name, defKind: "function", pinUncertain: false };
  let separator = "#";
  for (let index = defLine - 2; index >= 0; index--) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    if (DECORATOR_RE.test(line)) separator = ".";
    else if (!line.trimStart().startsWith("@")) break;
  }
  return { symbolId: `${scope.join(".")}${separator}${name}`, defKind: "function", pinUncertain: false };
}

/** One `textDocument/definition` hit, normalised over the three LSP shapes. */
export interface LspLocation {
  uri: string;
  /** 1-based, as `compose_symbol_id` and jedi's `name.line` both are. */
  line: number;
}

/** `Location`, `Location[]` and `LocationLink[]` all reach here; `null` is none. */
export function lspLocations(raw: unknown): LspLocation[] {
  const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.flatMap((entry): LspLocation[] => {
    const item = entry as Record<string, unknown>;
    const uri = (item.uri ?? item.targetUri) as string | undefined;
    const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as
      | { start: { line: number } }
      | undefined;
    return uri === undefined || range === undefined ? [] : [{ uri, line: range.start.line + 1 }];
  });
}

export const uriToPath = (uri: string): string | null =>
  uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : null;

/**
 * One site's answer, in `jedi_oracle.py`'s `answer_file` shape. Pure over the
 * server's reply, so the mapping is unit-tested on fixture responses with no
 * server running.
 *
 * `outcome.kind` follows `query_site`: `inProject` when any target's origin is
 * `project` / `generatedInRepo`, `external` for every other origin, `unknown`
 * when the engine returned no target at all. Targets are sorted by
 * `(relPath, defLine)` and `origin` is the FIRST in-project origin in reply
 * order, both exactly as the Python side does it.
 *
 * `siteFacts` is deliberately partial. `receiverIsAnnotatedParam`,
 * `enclosingHasReturnAnnotation`, `receiverIsUnion`, `isDecoratorSite` and
 * `targetIsProperty` need the CALLER's AST or the engine's own symbol kind;
 * this engine has neither, and `viaStarImport` is a fact jedi hardcodes false.
 * Emitting a false for any of them would move sites into shape categories
 * nobody measured, so they are omitted and `categorizePySite` reads them as
 * absent.
 */
export function answerForSite(input: {
  site: LspOracleSite;
  locations: readonly LspLocation[];
  corpusRoot: string;
  linesOf: (absPath: string) => readonly string[];
  stdlibNames?: ReadonlySet<string>;
}): PyOracleAnswer {
  const { site, corpusRoot } = input;
  const stdlibNames = input.stdlibNames ?? PYTHON_STDLIB_MODULES;
  const resolved = input.locations.flatMap((location) => {
    const path = uriToPath(location.uri);
    return path === null ? [] : [{ path, line: location.line, origin: classifyOrigin(path, corpusRoot, stdlibNames) }];
  });
  const facts = (targets: PyOracleAnswer["outcome"]["targets"]): Partial<PySiteFacts> => ({
    viaReexport: (targets ?? []).some((target) => target.relPath.endsWith("/__init__.py")),
    targetIsStaticOrClassMethod: (targets ?? []).some((target) => (target.symbolId ?? "").includes(".")),
    isSuperCall: site.receiver !== null && /^super\s*\(/.test(site.receiver),
  });
  const head = { startLine: site.startLine, member: site.member };
  if (resolved.length === 0) return { ...head, outcome: { kind: "unknown" }, siteFacts: facts(undefined) };

  const inProject = resolved.filter((entry) => PY_IN_PROJECT_ORIGINS.has(entry.origin));
  if (inProject.length === 0) {
    return {
      ...head,
      outcome: { kind: "external", origin: resolved[0].origin },
      siteFacts: facts(undefined),
    };
  }
  const targets = inProject
    .map((entry) => {
      const composed = composeSymbolId(input.linesOf(entry.path), entry.line);
      return {
        relPath: relative(corpusRoot, entry.path).split("\\").join("/"),
        symbolId: composed.symbolId,
        defLine: entry.line,
        // pyright reports no symbol kind of its own, so jedi's `name.type` has
        // no counterpart here and both fields carry the composer's answer.
        defKind: composed.defKind,
        defNodeKind: composed.defKind,
        pinUncertain: composed.pinUncertain,
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath) || a.defLine - b.defLine);
  return {
    ...head,
    outcome: { kind: "inProject", origin: inProject[0].origin, targets },
    siteFacts: facts(targets),
  };
}

/** `"python.analysis"` → `settings.python.analysis`, `null` when absent. */
export function settingsSection(settings: Record<string, unknown>, section: string): unknown {
  let cursor: unknown = settings;
  for (const part of section.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? null;
}

/** Minimal LSP stdio client: framed JSON-RPC, one pending map, no batching. */
export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  constructor(launcher: LspLauncher, cwd: string) {
    const [bin, ...args] = launcher.command;
    this.child = spawn(bin, args, { cwd, env: launcher.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.onData(chunk, launcher.settings);
    });
  }

  private onData(chunk: Buffer, settings: Record<string, unknown>): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = this.buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, header).toString("utf8"));
      if (match === null) throw new Error("no Content-Length in LSP header");
      const start = header + 4;
      const length = Number(match[1]);
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      const message = JSON.parse(body) as { id?: number; method?: string; params?: unknown; result?: unknown };
      // A server-to-client REQUEST carries a method as well as an id. The
      // configuration pull MUST be answered per item, resolving each item's
      // `section` against the settings tree — a one-element reply leaves the
      // server on its defaults, which the spike measured as `unknown` rising
      // from 8.6 % to 50.4 %.
      if (message.method !== undefined && message.id !== undefined) {
        this.replyToServer(message.id, message.method, message.params, settings);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        this.pending.get(message.id)?.(message.result ?? null);
        this.pending.delete(message.id);
      }
    }
  }

  private replyToServer(id: number, method: string, params: unknown, settings: Record<string, unknown>): void {
    if (method !== "workspace/configuration") {
      this.send({ jsonrpc: "2.0", id, result: null });
      return;
    }
    const items = ((params as { items?: { section?: string }[] } | undefined)?.items ?? [{}]).map((item) =>
      item.section === undefined ? settings : settingsSection(settings, item.section),
    );
    this.send({ jsonrpc: "2.0", id, result: items });
  }

  private send(payload: object): void {
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\r\n\r\n${body}`);
  }

  notify(method: string, params: object): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async request(method: string, params: object, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    const settled = new Promise<unknown>((done) => {
      this.pending.set(id, done);
      setTimeout(() => {
        if (this.pending.delete(id)) done(null);
      }, timeoutMs).unref();
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return settled;
  }

  kill(): void {
    this.child.kill();
  }
}

/** One `{kind:"file"}` record, as the host writes it. */
export interface LspOracleBatch {
  relPath: string;
  sites: LspOracleSite[];
}

/**
 * The long-lived process: one server for the whole corpus, one `didOpen` /
 * `didClose` per file, one `textDocument/definition` per site.
 *
 * Answers stay in the order the host sent the sites, and files are emitted in
 * `relPath` order, because `buildRows` joins a file's answers to its sites by
 * CURSOR — the Nth answer to the Nth site — and a reordering would silently
 * pair every row of a file with the wrong site.
 */
export class LspOracle {
  private readonly client: LspClient;
  private readonly targetLines = new Map<string, string[]>();

  constructor(
    private readonly config: LspOracleConfig,
    launcher: LspLauncher,
  ) {
    this.client = new LspClient(launcher, config.corpusRoot);
  }

  /** One parse per target file, the memo `_cached_tree` is on the Python side. */
  private readonly linesOf = (path: string): string[] => {
    const cached = this.targetLines.get(path);
    if (cached !== undefined) return cached;
    let text: string[];
    try {
      text = readFileSync(path, "utf8").split("\n");
    } catch {
      text = [];
    }
    this.targetLines.set(path, text);
    return text;
  };

  async initialize(settings: Record<string, unknown>): Promise<void> {
    const rootUri = pathToFileURL(this.config.corpusRoot).href;
    await this.client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        rootPath: this.config.corpusRoot,
        workspaceFolders: [{ uri: rootUri, name: "corpus" }],
        initializationOptions: settings,
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
          textDocument: { definition: { linkSupport: true }, synchronization: {} },
          window: { workDoneProgress: true },
        },
      },
      120_000,
    );
    this.client.notify("initialized", {});
    this.client.notify("workspace/didChangeConfiguration", { settings });
  }

  async answerFile(batch: LspOracleBatch): Promise<PyOracleFileReply> {
    const absolute = join(this.config.corpusRoot, batch.relPath);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      // Same shape as `answer_file`'s OSError path: no tree, so no ground truth.
      return { relPath: batch.relPath, parseFailed: true, parsoErrors: 0, answers: [] };
    }
    const lines = text.split("\n");
    const uri = pathToFileURL(absolute).href;
    this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text } });
    const answers: PyOracleAnswer[] = [];
    // Successive sites on ONE line claim successive occurrences, so two calls
    // to the same member on a line are not both pinned to the leftmost.
    const claimed = new Map<number, number>();
    for (const site of batch.sites) {
      const lineText = lines[site.startLine - 1] ?? "";
      const column =
        site.column !== undefined ? site.column : locateCalleeColumn(lineText, site, claimed.get(site.startLine) ?? 0);
      if (column < 0) {
        // The only unlocated shape this engine can name: the other three are
        // AST facts (`decoratorBare`, `multiLineCall`, `subscriptCall`) that a
        // definition request cannot distinguish.
        answers.push({
          startLine: site.startLine,
          member: site.member,
          outcome: { kind: "unknown" },
          unlocated: "coordinateMiss",
        });
        continue;
      }
      claimed.set(site.startLine, column + site.member.length);
      const raw = await this.client.request("textDocument/definition", {
        textDocument: { uri },
        position: { line: site.startLine - 1, character: column },
      });
      answers.push(
        answerForSite({
          site,
          locations: lspLocations(raw),
          corpusRoot: this.config.corpusRoot,
          linesOf: this.linesOf,
        }),
      );
    }
    this.client.notify("textDocument/didClose", { textDocument: { uri } });
    // `parsoErrors` is jedi's field and reads 0 from an engine with no jedi.
    return { relPath: batch.relPath, parseFailed: false, parsoErrors: 0, answers };
  }

  kill(): void {
    this.client.kill();
  }
}

async function main(): Promise<number> {
  const records: Record<string, unknown>[] = [];
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() !== "") records.push(JSON.parse(line) as Record<string, unknown>);
  }
  const config = records[0];
  if (config?.kind !== "config") {
    process.stderr.write("first stdin line must be the config record\n");
    return 2;
  }
  const resolved: LspOracleConfig = {
    corpusRoot: resolvePath(config.corpusRoot as string),
    venvPython: (config.venvPython as string | null | undefined) ?? null,
    roots: ((config.roots as string[] | undefined) ?? []).map((root) => resolvePath(root)),
    pythonVersion: config.pythonVersion as string | undefined,
  };
  const launcher = pyrightLauncher(resolved, process.env);
  const oracle = new LspOracle(resolved, launcher);
  await oracle.initialize(launcher.settings);
  // `workers` is in the contract because jedi pools processes; one language
  // server owns the whole workspace, so the field is read and ignored here.
  const batches = records
    .slice(1)
    .filter((record) => record.kind === "file")
    .map((record) => ({ relPath: record.relPath as string, sites: (record.sites ?? []) as LspOracleSite[] }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  let done = 0;
  for (const batch of batches) {
    const reply = await oracle.answerFile(batch);
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    done += 1;
    if (done % 25 === 0) process.stderr.write(`pyright: ${String(done)}/${String(batches.length)} files\n`);
  }
  oracle.kill();
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
