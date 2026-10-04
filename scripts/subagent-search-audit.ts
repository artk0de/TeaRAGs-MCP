/**
 * Subagent search audit — measures whether Claude Code subagents reach for
 * TeaRAGs MCP tools or fall back to Bash grep/cat/sed when they search code.
 *
 * Reads Claude Code transcripts (JSONL) under ~/.claude/projects, keeps only
 * subagent files (path contains `/subagents/`), classifies each subagent by the
 * search-tools block injected into its prompt, and aggregates tool usage per
 * injection variant. Bash greps that target code are bucketed by pattern shape
 * to show how many were symbol searches TeaRAGs would have answered.
 *
 * Usage: npx tsx scripts/subagent-search-audit.ts [--root <dir>]... [--since <ISO date>] [--json]
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export type InjectionVariant = "none" | "legacy" | "wto8";

export const INJECTION_VARIANTS: readonly InjectionVariant[] = ["none", "legacy", "wto8"];

export type GrepClass =
  | "pipe filter"
  | "single identifier"
  | "identifier alternation"
  | "qualified symbol"
  | "comment/marker"
  | "literal phrase"
  | "regex/other"
  | "unparsed";

export const GREP_CLASSES: readonly GrepClass[] = [
  "pipe filter",
  "single identifier",
  "identifier alternation",
  "qualified symbol",
  "comment/marker",
  "literal phrase",
  "regex/other",
  "unparsed",
];

/** Grep classes that are really symbol lookups — find_symbol / hybrid_search territory. */
const SYMBOL_SHAPED: readonly GrepClass[] = ["single identifier", "identifier alternation", "qualified symbol"];

export interface SubagentAudit {
  injection: InjectionVariant;
  firstTimestamp: string | null;
  inWorktree: boolean;
  bashSearchRead: number;
  teaRagsCalls: number;
  teaRagsByTool: Record<string, number>;
  teaRagsWithPath: number;
  teaRagsProjectOnly: number;
  readCalls: number;
  grepGlobCalls: number;
  grepClasses: Record<GrepClass, number>;
}

export interface InjectionVariantStats {
  agents: number;
  inWorktree: number;
  bashSearchRead: number;
  teaRagsCalls: number;
  teaRagsWithPath: number;
  teaRagsProjectOnly: number;
  readCalls: number;
  /** null when the variant has no agents. */
  bashPerAgent: number | null;
  /** null when the variant has no agents. */
  teaRagsPerAgent: number | null;
  /** teaRagsWithPath / teaRagsCalls; null when there were no tea-rags calls. */
  pathShare: number | null;
  teaRagsByTool: Record<string, number>;
}

export interface AuditReport {
  byInjection: Record<InjectionVariant, InjectionVariantStats>;
  grepClasses: Record<GrepClass, number>;
  /** Symbol-shaped greps / all code-targeting greps; null when there were none. */
  symbolShapedShare: number | null;
}

export interface AuditRunOptions {
  roots: string[];
  since?: string | null;
}

export interface AuditRun extends AuditReport {
  files: number;
  since: string | null;
  roots: string[];
}

const TEA_RAGS_PREFIX = "mcp__tea-rags__";
const WTO8_MARKER = "Address tea-rags with YOUR working directory";
const LEGACY_MARKER = "Search Tools (MANDATORY";
const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** Optional `cd <dir> &&|;` prefix, then a read/search command as the first command. */
const BASH_SEARCH_READ = /^\s*(cd [^;&]+(&&|;)\s*)?(cat|head|tail|sed -n|rg|grep|find|awk|wc)\b/;
const CD_PREFIX = /^cd [^;&]+(&&|;)\s*/;
const GREP_WORD = /\b(grep|rg)\b/;
const CODE_TARGET = /(src\/|tests\/|\.tsx?\b|\.rb\b|\.py\b|\.swift\b)/;
const PIPED_GREP = /\|\s*(grep|rg)/;
const LEADING_GREP = /^\s*(grep|rg)/;
/** First grep/rg invocation with a quoted pattern (flags may carry unquoted values). */
const QUOTED_PATTERN = /\b(grep|rg)\b((?:\s+-{1,2}[\w-]+(?:[= ](?!['"])\S+)?)*)\s+(?:-e\s+)?(['"])(.*?)\3/;
/** Fallback: first bare word after the flags. */
const BARE_PATTERN = /\b(grep|rg)\b((?:\s+-{1,2}[\w-]+)*)\s+([^\s'"|]+)/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const IDENTIFIER_ALTERNATION = /^[A-Za-z_$][\w$]*(\\?\|[A-Za-z_$][\w$]*)+$/;
const QUALIFIED_SYMBOL = /^[A-Za-z_$][\w$]*([.#:]{1,2}[A-Za-z_$][\w$]*)+\(?$/;
const COMMENT_MARKER = /(TODO|FIXME|HACK|NOTE|\/\/|#\s)/;
const REGEX_META = /[\\[\]()*+?^$]/;

export function classifyInjection(firstPrompt: string): InjectionVariant {
  if (firstPrompt.includes(WTO8_MARKER)) return "wto8";
  if (firstPrompt.includes(LEGACY_MARKER)) return "legacy";
  return "none";
}

export function isBashSearchRead(command: string): boolean {
  return BASH_SEARCH_READ.test(command);
}

function extractGrepPattern(command: string): string | null {
  const quoted = QUOTED_PATTERN.exec(command);
  if (quoted) return quoted[4];
  const bare = BARE_PATTERN.exec(command);
  return bare ? bare[3] : null;
}

function isPipeFilter(command: string): boolean {
  if (!PIPED_GREP.test(command)) return false;
  const firstStage = command.split("|")[0].trim().replace(CD_PREFIX, "");
  return !LEADING_GREP.test(firstStage);
}

export function classifyGrepPattern(command: string): GrepClass | null {
  if (!GREP_WORD.test(command) || !CODE_TARGET.test(command)) return null;
  if (isPipeFilter(command)) return "pipe filter";

  const pattern = extractGrepPattern(command);
  if (pattern === null) return "unparsed";
  if (IDENTIFIER.test(pattern)) return "single identifier";
  if (IDENTIFIER_ALTERNATION.test(pattern)) return "identifier alternation";
  if (QUALIFIED_SYMBOL.test(pattern)) return "qualified symbol";
  if (COMMENT_MARKER.test(pattern)) return "comment/marker";
  if (/\s/.test(pattern) && !REGEX_META.test(pattern)) return "literal phrase";
  return "regex/other";
}

function emptyGrepClasses(): Record<GrepClass, number> {
  const classes = {} as Record<GrepClass, number>;
  for (const grepClass of GREP_CLASSES) classes[grepClass] = 0;
  return classes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function messageContent(entry: Record<string, unknown>): unknown {
  return isRecord(entry.message) ? entry.message.content : undefined;
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

function increment(counter: Record<string, number>, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

function recordToolUse(audit: SubagentAudit, name: string, input: Record<string, unknown>): void {
  if (name.startsWith(TEA_RAGS_PREFIX)) {
    audit.teaRagsCalls++;
    increment(audit.teaRagsByTool, name.slice(TEA_RAGS_PREFIX.length));
    const hasPath = typeof input.path === "string" && input.path.length > 0;
    if (hasPath) audit.teaRagsWithPath++;
    else if ("project" in input || "collection" in input) audit.teaRagsProjectOnly++;
    return;
  }
  if (name === "Read") {
    audit.readCalls++;
    return;
  }
  if (name === "Grep" || name === "Glob") {
    audit.grepGlobCalls++;
    return;
  }
  if (name === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (isBashSearchRead(command)) audit.bashSearchRead++;
    const grepClass = classifyGrepPattern(command);
    if (grepClass !== null) audit.grepClasses[grepClass]++;
  }
}

/** Incremental form of {@link auditTranscript}, so the CLI can stream huge files line by line. */
export class TranscriptAuditor {
  private readonly audit: SubagentAudit = {
    injection: "none",
    firstTimestamp: null,
    inWorktree: false,
    bashSearchRead: 0,
    teaRagsCalls: 0,
    teaRagsByTool: {},
    teaRagsWithPath: 0,
    teaRagsProjectOnly: 0,
    readCalls: 0,
    grepGlobCalls: 0,
    grepClasses: emptyGrepClasses(),
  };
  private promptSeen = false;

  push(line: string): void {
    const entry = parseLine(line);
    if (!entry) return;

    if (this.audit.firstTimestamp === null && typeof entry.timestamp === "string") {
      this.audit.firstTimestamp = entry.timestamp;
    }
    if (typeof entry.cwd === "string" && entry.cwd.includes(WORKTREE_SEGMENT)) this.audit.inWorktree = true;

    const content = messageContent(entry);
    if (entry.type === "user" && !this.promptSeen) {
      this.promptSeen = true;
      this.audit.injection = classifyInjection(promptText(content));
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) return;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool_use" || typeof part.name !== "string") continue;
      recordToolUse(this.audit, part.name, isRecord(part.input) ? part.input : {});
    }
  }

  result(): SubagentAudit {
    return this.audit;
  }
}

export function auditTranscript(lines: Iterable<string>): SubagentAudit {
  const auditor = new TranscriptAuditor();
  for (const line of lines) auditor.push(line);
  return auditor.result();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round2(numerator / denominator);
}

function emptyVariantStats(): InjectionVariantStats {
  return {
    agents: 0,
    inWorktree: 0,
    bashSearchRead: 0,
    teaRagsCalls: 0,
    teaRagsWithPath: 0,
    teaRagsProjectOnly: 0,
    readCalls: 0,
    bashPerAgent: null,
    teaRagsPerAgent: null,
    pathShare: null,
    teaRagsByTool: {},
  };
}

export function aggregateAudits(audits: SubagentAudit[]): AuditReport {
  const byInjection = {} as Record<InjectionVariant, InjectionVariantStats>;
  for (const variant of INJECTION_VARIANTS) byInjection[variant] = emptyVariantStats();
  const grepClasses = emptyGrepClasses();

  for (const audit of audits) {
    const stats = byInjection[audit.injection];
    stats.agents++;
    if (audit.inWorktree) stats.inWorktree++;
    stats.bashSearchRead += audit.bashSearchRead;
    stats.teaRagsCalls += audit.teaRagsCalls;
    stats.teaRagsWithPath += audit.teaRagsWithPath;
    stats.teaRagsProjectOnly += audit.teaRagsProjectOnly;
    stats.readCalls += audit.readCalls;
    for (const [tool, count] of Object.entries(audit.teaRagsByTool)) increment(stats.teaRagsByTool, tool, count);
    for (const grepClass of GREP_CLASSES) grepClasses[grepClass] += audit.grepClasses[grepClass];
  }

  for (const stats of Object.values(byInjection)) {
    stats.bashPerAgent = ratio(stats.bashSearchRead, stats.agents);
    stats.teaRagsPerAgent = ratio(stats.teaRagsCalls, stats.agents);
    stats.pathShare = ratio(stats.teaRagsWithPath, stats.teaRagsCalls);
  }

  const totalGreps = GREP_CLASSES.reduce((sum, grepClass) => sum + grepClasses[grepClass], 0);
  const symbolShaped = SYMBOL_SHAPED.reduce((sum, grepClass) => sum + grepClasses[grepClass], 0);
  return { byInjection, grepClasses, symbolShapedShare: ratio(symbolShaped, totalGreps) };
}

function findSubagentTranscripts(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl") && path.includes("/subagents/")) files.push(path);
    }
  };
  walk(root);
  return files;
}

async function auditFile(path: string): Promise<SubagentAudit> {
  const auditor = new TranscriptAuditor();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) auditor.push(line);
  return auditor.result();
}

function keptBySince(audit: SubagentAudit, sinceMs: number | null): boolean {
  if (sinceMs === null) return true;
  if (audit.firstTimestamp === null) return false;
  const startedMs = Date.parse(audit.firstTimestamp);
  return !Number.isNaN(startedMs) && startedMs >= sinceMs;
}

export async function runAudit(options: AuditRunOptions): Promise<AuditRun> {
  const since = options.since ?? null;
  const sinceMs = since === null ? null : Date.parse(since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`Invalid --since date: ${since}`);

  const files = options.roots.flatMap(findSubagentTranscripts);
  const audits: SubagentAudit[] = [];
  for (const file of files) {
    const audit = await auditFile(file);
    if (keptBySince(audit, sinceMs)) audits.push(audit);
  }
  return { ...aggregateAudits(audits), files: files.length, since, roots: options.roots };
}

const PROJECT_DIR_NAME = "-Users-artk0re-Dev-Tools-tea-rags-mcp";

/** The main project transcript dir plus every worktree-session sibling dir. */
export function defaultRoots(projectsDir = join(homedir(), ".claude", "projects")): string[] {
  const roots = [join(projectsDir, PROJECT_DIR_NAME)];
  if (!existsSync(projectsDir)) return roots;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`${PROJECT_DIR_NAME}-`)) {
      roots.push(join(projectsDir, entry.name));
    }
  }
  return roots;
}

export interface SubagentAuditCliArgs {
  roots: string[];
  since: string | null;
  json: boolean;
}

export function parseArgs(argv: string[]): SubagentAuditCliArgs {
  const roots: string[] = [];
  let since: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--root" || arg === "--since") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      if (arg === "--root") roots.push(value);
      else since = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { roots: roots.length > 0 ? roots : defaultRoots(), since, json };
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : String(value);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, col) => Math.max(cell.length, ...rows.map((row) => row[col].length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, col) => cell.padEnd(widths[col]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function renderHuman(run: AuditRun): string {
  const variantRows = INJECTION_VARIANTS.map((variant) => {
    const stats = run.byInjection[variant];
    return [
      variant,
      String(stats.agents),
      formatNumber(stats.bashPerAgent),
      formatNumber(stats.teaRagsPerAgent),
      formatNumber(stats.pathShare),
      String(stats.inWorktree),
    ];
  });
  const grepRows = GREP_CLASSES.map((grepClass) => [grepClass, String(run.grepClasses[grepClass])]);
  return [
    `subagent files: ${run.files}  since: ${run.since ?? "-"}`,
    "",
    renderTable(["injection", "agents", "bash/agent", "tea-rags/agent", "pathShare", "inWorktree"], variantRows),
    "",
    renderTable(["grep class", "count"], grepRows),
    `symbol-shaped share: ${formatNumber(run.symbolShapedShare)}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const run = await runAudit({ roots: args.roots, since: args.since });
  console.log(args.json ? JSON.stringify(run, null, 2) : renderHuman(run));
}
