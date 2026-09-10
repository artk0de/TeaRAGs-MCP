/**
 * SPIKE (bd tea-rags-mcp-w205u, E4.0.1) — minimal LSP stdio client that asks a
 * language server `textDocument/definition` at every call site the jedi host
 * enumerated, and emits rows in `jedi_oracle.py`'s schema.
 *
 * This file is the SEED of E4.0.2's `scripts/py-oracle/lsp_oracle.ts`: both
 * candidates speak LSP, so the transport is shared and only the launcher record
 * and the per-corpus configuration differ. It is a spike — it reads a site dump
 * rather than the host's stdin NDJSON contract, and it has no worker pool.
 *
 * Usage:
 *   npx tsx scripts/spikes/lsp-definition-probe.ts --engine pyright|ty \
 *     --corpus <abs path> --sites sites.ndjson --out answers.ndjson \
 *     [--venv <corpus venv>] [--python-version 3.14] [--limit N]
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

/** Pinned, cache-local. Never installed globally; `npx`/`uvx` resolve them. */
const PYRIGHT_VERSION = "1.1.414";
const TY_VERSION = "0.0.80";
const UVX_BIN = "/opt/homebrew/bin/uvx";

/** `classify_origin`'s ORDER, ported line-for-line (`jedi_oracle.py:64`). */
const STDLIB_DIR_RE = /\/lib\/python3\.\d+\/(?!site-packages\/)/;
// jedi's markers plus each candidate's own bundled typeshed: pyright ships
// `dist/typeshed-fallback/`, ty unpacks `~/.cache/ty/vendored/typeshed/<sha>/`.
// Without them a stdlib answer reads `outsideRepo` and the origin column stops
// being comparable across engines.
const STUB_MARKERS = [
  "/jedi/third_party/typeshed/",
  "/jedi/third_party/django-stubs/",
  "/typeshed-fallback/",
  "/vendored/typeshed/",
];

export type SpikeOrigin =
  | "builtin"
  | "typeshedStub"
  | "sitePackages"
  | "stdlib"
  | "outsideRepo"
  | "generatedInRepo"
  | "project";

export function classifyOrigin(targetPath: string | null, corpusRoot: string): SpikeOrigin {
  if (targetPath === null) return "builtin";
  if (STUB_MARKERS.some((marker) => targetPath.includes(marker))) return "typeshedStub";
  if (targetPath.includes("/site-packages/") || targetPath.includes("/dist-packages/")) return "sitePackages";
  if (STDLIB_DIR_RE.test(targetPath)) return "stdlib";
  if (!targetPath.startsWith(`${corpusRoot.replace(/\/$/, "")}/`)) return "outsideRepo";
  const rel = targetPath.slice(corpusRoot.replace(/\/$/, "").length + 1);
  return rel.split("/").includes("migrations") ? "generatedInRepo" : "project";
}

/** `compose_symbol_id` (`jedi_oracle.py:98`), over the target file's own text. */
const DEF_RE = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DECORATOR_RE = /^\s*@\s*(staticmethod|classmethod)\b/;

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

interface LspLocation {
  uri: string;
  line: number;
}

/** `"python.analysis"` → `settings.python.analysis`, `null` when absent. */
function sectionOf(settings: Record<string, unknown>, section: string): unknown {
  let cursor: unknown = settings;
  for (const part of section.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? null;
}

class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private readonly requested = new Map<number, string>();

  constructor(
    command: readonly string[],
    cwd: string,
    private readonly settings: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
  ) {
    const [bin, ...args] = command;
    this.child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = this.buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const head = this.buffer.subarray(0, header).toString("utf8");
      const match = /Content-Length: (\d+)/i.exec(head);
      if (match === null) throw new Error("no Content-Length in LSP header");
      const length = Number(match[1]);
      const start = header + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      const message = JSON.parse(body) as { id?: number; method?: string; params?: unknown; result?: unknown };
      // A server-to-client REQUEST carries a method as well as an id; the
      // configuration pull both engines make must be answered PER ITEM or the
      // server keeps its defaults — which is the difference between reading the
      // corpus venv and not reading it.
      if (message.method !== undefined && message.id !== undefined) {
        this.reply(message.id, message.method, message.params);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        this.pending.get(message.id)?.(message.result ?? null);
        this.pending.delete(message.id);
        this.requested.delete(message.id);
      }
    }
  }

  private reply(id: number, method: string, params: unknown): void {
    if (method !== "workspace/configuration") {
      this.send({ jsonrpc: "2.0", id, result: null });
      return;
    }
    const items = ((params as { items?: { section?: string }[] } | undefined)?.items ?? [{}]).map((item) =>
      item.section === undefined ? this.settings : sectionOf(this.settings, item.section),
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
    this.requested.set(id, method);
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

interface Site {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind?: string;
}

const read = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const uriToPath = (uri: string): string | null => (uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : null);

const targetsOf = (raw: unknown): LspLocation[] => {
  const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.flatMap((entry): LspLocation[] => {
    const item = entry as Record<string, unknown>;
    const uri = (item.uri ?? item.targetUri) as string | undefined;
    const range = (item.range ?? item.targetSelectionRange ?? item.targetRange) as
      | { start: { line: number } }
      | undefined;
    return uri === undefined || range === undefined ? [] : [{ uri, line: range.start.line + 1 }];
  });
};

const serverRssKb = (pid: number | undefined): number => {
  if (pid === undefined) return 0;
  try {
    const out = execFileSync("/bin/ps", ["-axo", "rss=,pid=,ppid="], { encoding: "utf8" });
    const rows = out
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((cells) => cells.length === 3 && Number.isFinite(cells[0]));
    const own = new Set([pid]);
    for (const [, child, parent] of rows) if (own.has(parent)) own.add(child);
    return rows.filter(([, id]) => own.has(id)).reduce((sum, [rss]) => sum + rss, 0);
  } catch {
    return 0;
  }
};

const locateMember = (line: string, member: string): number => {
  const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?<![A-Za-z0-9_])${escaped}\\s*[([]`).exec(line);
  if (found !== null) return found.index;
  const bare = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).exec(line);
  return bare === null ? -1 : bare.index;
};

async function main(): Promise<void> {
  const engine = read("--engine") ?? "pyright";
  const corpus = resolvePath(read("--corpus") ?? process.cwd());
  const venv = read("--venv");
  const pythonVersion = read("--python-version") ?? "3.13";
  const limit = Number(read("--limit") ?? Number.MAX_SAFE_INTEGER);
  const sites = readFileSync(read("--sites") ?? "", "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Site)
    .slice(0, limit);

  // Per-corpus configuration is the whole of what differs between engines:
  // pyright takes `pythonPath` / `venvPath` / `pythonVersion` through
  // `workspace/configuration`, ty takes `ty.environment.python`. BOTH also read
  // `VIRTUAL_ENV` from the child env, which is set below because it is the one
  // channel neither can misread. `extraPaths` mirrors the manifest's declared
  // source roots — the same list `build_sys_path` puts ahead of the venv.
  const venvDir = venv === undefined ? undefined : resolvePath(venv, "..", "..");
  const extraPaths = (read("--roots") ?? "")
    .split(",")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => join(corpus, entry.trim()));
  const launchers: Record<string, { command: string[]; settings: Record<string, unknown> }> = {
    pyright: {
      command: ["npx", "--yes", "--package", `pyright@${PYRIGHT_VERSION}`, "pyright-langserver", "--stdio"],
      settings: {
        python: {
          pythonPath: venv ?? "python3",
          venvPath: venvDir === undefined ? undefined : resolvePath(venvDir, ".."),
          venv: venvDir === undefined ? undefined : venvDir.split("/").pop(),
          analysis: {
            typeCheckingMode: "basic",
            diagnosticMode: "openFilesOnly",
            useLibraryCodeForTypes: true,
            autoSearchPaths: true,
            pythonVersion,
            extraPaths,
          },
        },
        pyright: { disableLanguageServices: false },
      },
    },
    ty: {
      command: [UVX_BIN, `ty@${TY_VERSION}`, "server"],
      settings: {
        ty: {
          diagnosticMode: "openFilesOnly",
          experimental: { autoImport: false },
          ...(venv === undefined ? {} : { environment: { python: venv, pythonVersion, extraPaths } }),
        },
      },
    },
  };
  const launcher = launchers[engine];
  if (launcher === undefined) throw new Error(`unknown engine ${engine}`);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(venvDir === undefined ? {} : { VIRTUAL_ENV: venvDir, PATH: `${venvDir}/bin:${process.env.PATH ?? ""}` }),
  };
  const client = new LspClient(launcher.command, corpus, launcher.settings, childEnv);
  const rootUri = pathToFileURL(corpus).href;
  const started = Date.now();
  await client.request(
    "initialize",
    {
      processId: process.pid,
      rootUri,
      rootPath: corpus,
      workspaceFolders: [{ uri: rootUri, name: "corpus" }],
      initializationOptions: launcher.settings,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
        textDocument: { definition: { linkSupport: true }, synchronization: {} },
        window: { workDoneProgress: true },
      },
    },
    120_000,
  );
  client.notify("initialized", {});
  client.notify("workspace/didChangeConfiguration", { settings: launcher.settings });

  const byFile = new Map<string, Site[]>();
  for (const site of sites) {
    const bucket = byFile.get(site.relPath);
    if (bucket) bucket.push(site);
    else byFile.set(site.relPath, [site]);
  }

  const targetLines = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    const cached = targetLines.get(path);
    if (cached !== undefined) return cached;
    let text: string[];
    try {
      text = readFileSync(path, "utf8").split("\n");
    } catch {
      text = [];
    }
    targetLines.set(path, text);
    return text;
  };

  const answers: unknown[] = [];
  let files = 0;
  // The server is a CHILD, so `process.memoryUsage` is blind to it. `ps` over
  // the process group covers pyright's `npx` → node hop and ty's single binary
  // alike, and the sample is taken at file boundaries — the peak is between
  // them only if a single file is pathological.
  let peakRssKb = 0;
  for (const relPath of [...byFile.keys()].sort()) {
    const absolute = join(corpus, relPath);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const uri = pathToFileURL(absolute).href;
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text } });
    for (const site of byFile.get(relPath) ?? []) {
      const key = {
        relPath: site.relPath,
        startLine: site.startLine,
        callText: site.callText,
        receiver: site.receiver,
        member: site.member,
      };
      const column = locateMember(lines[site.startLine - 1] ?? "", site.member);
      if (column < 0) {
        answers.push({ ...key, oracleKind: "unknown", oracleOrigin: null, unlocated: "coordinateMiss" });
        continue;
      }
      const raw = await client.request("textDocument/definition", {
        textDocument: { uri },
        position: { line: site.startLine - 1, character: column },
      });
      const located = targetsOf(raw);
      if (located.length === 0) {
        answers.push({ ...key, oracleKind: "unknown", oracleOrigin: null });
        continue;
      }
      const resolved = located.flatMap((location) => {
        const path = uriToPath(location.uri);
        return path === null ? [] : [{ path, line: location.line, origin: classifyOrigin(path, corpus) }];
      });
      const inProject = resolved.filter((entry) => entry.origin === "project" || entry.origin === "generatedInRepo");
      if (inProject.length === 0) {
        answers.push({
          ...key,
          oracleKind: "external",
          oracleOrigin: resolved[0]?.origin ?? "builtin",
          oracleExternalPath: resolved[0]?.path ?? null,
        });
        continue;
      }
      const best = [...inProject].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)[0];
      const composed = composeSymbolId(linesOf(best.path), best.line);
      answers.push({
        ...key,
        oracleKind: "inProject",
        oracleOrigin: best.origin,
        oracleTargetRelPath: best.path.slice(corpus.replace(/\/$/, "").length + 1),
        oracleTargetSymbolId: composed.symbolId,
        oracleTargetDefLine: best.line,
        oracleTargetDefKind: composed.defKind,
        oracleTargetPinUncertain: composed.pinUncertain,
      });
    }
    client.notify("textDocument/didClose", { textDocument: { uri } });
    files += 1;
    peakRssKb = Math.max(peakRssKb, serverRssKb(client.pid));
    if (files % 10 === 0) {
      process.stderr.write(
        `${engine}: ${String(files)}/${String(byFile.size)} files, ${String(answers.length)} sites\n`,
      );
    }
  }
  const wallMs = Date.now() - started;
  client.kill();
  writeFileSync(read("--out") ?? "answers.ndjson", `${answers.map((row) => JSON.stringify(row)).join("\n")}\n`);
  process.stderr.write(
    `${engine}: ${String(answers.length)} sites in ${(wallMs / 1000).toFixed(1)}s ` +
      `(${(wallMs / Math.max(answers.length, 1)).toFixed(1)}s per 1k sites) ` +
      `peakRss ${(peakRssKb / 1024).toFixed(0)}MB\n`,
  );
}

await main();
