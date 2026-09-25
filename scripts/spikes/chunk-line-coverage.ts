/**
 * Chunk line-coverage probe (bd tea-rags-mcp-deoki).
 *
 * Runs the COMPILED `TreeSitterChunker` (build/) over a corpus and reports,
 * per corpus, the non-blank source lines no chunk covers. Coverage is read
 * from each chunk's `lineRanges` when present, else `startLine..endLine` —
 * never from text matching, which over-credits repeated lines.
 *
 * Two uncovered counts are reported:
 *   - `inContainer`: rows inside a top-level chunkable node (the container
 *     the engine walked) — the defect class deoki targets;
 *   - `total`: every uncovered non-blank row, including module-level code no
 *     chunkable node owns (out of deoki's scope, reported for context).
 * Each count is split into all non-blank rows and "substantive" rows (rows
 * that are not pure closing punctuation such as `}` / `});` / `end`).
 *
 * Also reports chunk count and duplicate symbolIds (same id twice in one
 * file). `--dump <file>` writes per-file `[symbolId, startLine, endLine]`
 * lists so two runs can be diffed (`--diff <before> <after>`).
 *
 * Usage:
 *   npx tsx scripts/spikes/chunk-line-coverage.ts --dump /tmp/before.json
 *   npx tsx scripts/spikes/chunk-line-coverage.ts --diff /tmp/before.json /tmp/after.json
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { TreeSitterChunker } from "../../build/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../build/core/domains/language/index.js";
import { materializeTree } from "../../build/core/infra/materialize.js";

interface Corpus {
  name: string;
  root: string;
  ext: string;
  language: string;
}

const REPO = join(import.meta.dirname, "..", "..");
const OSS = join(homedir(), "Dev/OpenSource/codegraph-test");
const CORPORA: Corpus[] = [
  { name: "tea-rags src (ts)", root: join(REPO, "src"), ext: ".ts", language: "typescript" },
  { name: "express (js)", root: join(OSS, "express"), ext: ".js", language: "javascript" },
  { name: "flask (py)", root: join(OSS, "flask"), ext: ".py", language: "python" },
  { name: "sinatra (rb)", root: join(OSS, "sinatra"), ext: ".rb", language: "ruby" },
  { name: "iTerm2 (swift)", root: join(homedir(), "Dev/OpenSource/iTerm2"), ext: ".swift", language: "swift" },
];

/** Chunk budget the probe runs the engine under. */
const MAX_CHUNK_SIZE = 2500;
/** A line that opens a scope: the only kind a hierarchy prefix is built from. */
const HEADER_LIKE =
  /^(abstract\s+)?(class|module|struct|enum|extension|protocol|interface|namespace|impl|actor|trait)\b|^(const|let|var)\s+\S+\s*=\s*\{$|^(RSpec\.)?(describe|context)\b/;

/** A header row with its export / visibility keywords dropped, for comparison. */
function normalizeHeader(line: string): string {
  return line.trim().replace(/^(export\s+(default\s+)?|declare\s+|public\s+|open\s+|final\s+)+/, "");
}

/**
 * bd tea-rags-mcp-4i6ab — the chunk repeats a scope header: one of its leading
 * (prefix) lines comes back verbatim, modulo `export`, among the next leading
 * lines. Both occurrences sit in the first `HEAD_WINDOW` rows — a repeat deep
 * in the body is the source repeating itself, not a doubled prefix.
 */
const HEAD_WINDOW = 5;
function repeatsHeader(content: string): boolean {
  const lines = content.split("\n").slice(0, HEAD_WINDOW).map(normalizeHeader);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (head.length < 6 || !HEADER_LIKE.test(head)) continue;
    if (lines.indexOf(head, i + 1) > 0) return true;
  }
  return false;
}

/**
 * bd tea-rags-mcp-jgb5a — a `#partN` of a split MEMBER (`Foo#bar#part2`,
 * `Foo.bar#part1`) whose content never names its container on the first row.
 * A container whose node opens on an attribute row (`@MainActor`,
 * `@NSApplicationMain`, `#[derive(..)]`) has that row as its engine header —
 * the unsplit members carry the same line — so such a first row counts as the
 * header.
 */
function splitMemberLacksContainer(symbolId: string | undefined, content: string): boolean {
  const m = symbolId?.match(/^(.*)#part\d+$/);
  if (!m) return false;
  const base = m[1];
  const cut = Math.max(base.lastIndexOf("#"), base.lastIndexOf("."), base.lastIndexOf("::"));
  if (cut <= 0) return false;
  // Any segment of the container path: intermediate scopes fold into the id
  // (`LLM.Message.Body#tryAppend`) but the prefix names the outer container.
  const owners = base
    .slice(0, cut)
    .split(/#|\.|::/)
    .filter((segment) => segment !== "");
  if (owners.length === 0) return false;
  const firstRow = (content.split("\n")[0] ?? "").trim();
  return !owners.some((owner) => firstRow.includes(owner)) && !/^(@|#\[)/.test(firstRow);
}

const PUNCTUATION_ONLY = /^[\s{}()[\];,]*$|^\s*end\s*$/;
const COMMENT_ROW = /^\s*(\/\/|\/\*|\*|#)/;

function walk(dir: string, ext: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext) && !entry.endsWith(".d.ts")) out.push(full);
  }
}

type FileDump = [string | null, number, number][];

async function measure(dump: Record<string, FileDump>) {
  const chunker = new TreeSitterChunker(
    { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: MAX_CHUNK_SIZE },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  // Probe-only access to the engine's private container discovery, so the
  // "inside a container" denominator is the SAME node set the engine walked.
  const engine = chunker as unknown as {
    getLanguageConfig: (l: string) => Promise<{
      parser: { parse: (c: string) => { rootNode: unknown } };
      chunkableTypes: string[];
      hooks?: unknown[];
    } | null>;
    findChunkableNodes: (
      n: unknown,
      t: string[],
      h: unknown,
      c: string,
      f: string,
    ) => {
      startPosition: { row: number };
      endPosition: { row: number };
      startIndex: number;
      endIndex: number;
    }[];
  };

  const rows: string[] = [];
  for (const corpus of CORPORA) {
    const files: string[] = [];
    walk(corpus.root, corpus.ext, files);
    files.sort();
    const langConfig = await engine.getLanguageConfig(corpus.language);
    let nonBlank = 0;
    let uncoveredTotal = 0;
    let uncoveredTotalSubst = 0;
    let uncoveredInContainer = 0;
    let uncoveredInContainerSubst = 0;
    let uncoveredInContainerComment = 0;
    let chunkCount = 0;
    let dupIds = 0;
    let doubleHeader = 0;
    let splitMemberNoHeader = 0;
    let splitMemberParts = 0;
    let maxLen = 0;
    let overBudget = 0;
    const doubleHeaderSamples: string[] = [];
    const noHeaderSamples: string[] = [];
    const worstFiles: [string, number][] = [];

    for (const file of files) {
      const code = readFileSync(file, "utf8");
      const rel = relative(corpus.root, file);
      const chunks = await chunker.chunk(code, rel, corpus.language);
      chunkCount += chunks.length;
      dump[`${corpus.name}:${rel}`] = chunks.map((c) => [c.metadata.symbolId ?? null, c.startLine, c.endLine]);

      for (const c of chunks) {
        maxLen = Math.max(maxLen, c.content.length);
        if (c.content.length > MAX_CHUNK_SIZE) overBudget++;
        if (repeatsHeader(c.content)) {
          doubleHeader++;
          if (doubleHeaderSamples.length < 3) doubleHeaderSamples.push(`${rel}:${c.metadata.symbolId}@${c.startLine}`);
        }
        const id = c.metadata.symbolId;
        if (id && /#part\d+$/.test(id) && /[#.]|::/.test(id.replace(/#part\d+$/, ""))) splitMemberParts++;
        if (splitMemberLacksContainer(id, c.content)) {
          splitMemberNoHeader++;
          if (noHeaderSamples.length < 3) noHeaderSamples.push(`${rel}:${id}`);
        }
      }

      const seen = new Map<string, number>();
      for (const c of chunks) {
        const id = c.metadata.symbolId;
        if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      for (const n of seen.values()) if (n > 1) dupIds += n - 1;

      const covered = new Set<number>();
      for (const c of chunks) {
        const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
        for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
      }

      const inContainer = new Set<number>();
      if (langConfig) {
        const root = materializeTree(langConfig.parser.parse(code).rootNode as never, code);
        const nodes = engine.findChunkableNodes(root, langConfig.chunkableTypes, langConfig.hooks, code, rel);
        for (const n of nodes) {
          if (n.endIndex - n.startIndex < 50) continue;
          for (let r = n.startPosition.row; r <= n.endPosition.row; r++) inContainer.add(r + 1);
        }
      }

      const lines = code.split("\n");
      let fileMissing = 0;
      lines.forEach((text, i) => {
        if (text.trim() === "") return;
        const line = i + 1;
        nonBlank++;
        if (covered.has(line)) return;
        const subst = !PUNCTUATION_ONLY.test(text);
        uncoveredTotal++;
        if (subst) uncoveredTotalSubst++;
        if (inContainer.has(line)) {
          uncoveredInContainer++;
          if (subst) {
            uncoveredInContainerSubst++;
            if (COMMENT_ROW.test(text)) uncoveredInContainerComment++;
            fileMissing++;
          }
        }
      });
      if (fileMissing > 0) worstFiles.push([rel, fileMissing]);
    }

    worstFiles.sort((a, b) => b[1] - a[1]);
    rows.push(
      `${corpus.name}: files=${files.length} chunks=${chunkCount} dupIds=${dupIds} nonBlank=${nonBlank} ` +
        `doubleHeader=${doubleHeader} splitMemberParts=${splitMemberParts} splitMemberNoHeader=${splitMemberNoHeader} ` +
        `maxLen=${maxLen} overBudget=${overBudget} ` +
        `uncoveredInContainer=${uncoveredInContainer} (substantive ${uncoveredInContainerSubst}, of which comment ${uncoveredInContainerComment}) ` +
        `uncoveredTotal=${uncoveredTotal} (substantive ${uncoveredTotalSubst})\n    worst: ${worstFiles
          .slice(0, 5)
          .map(([f, n]) => `${f}=${n}`)
          .join(", ")}` +
        `\n    doubleHeader: ${doubleHeaderSamples.join(", ")}\n    splitMemberNoHeader: ${noHeaderSamples.join(", ")}`,
    );
  }
  return rows;
}

function isTestPath(key: string): boolean {
  return (
    /(^|[/:])(tests?|spec|__tests__)\//.test(key) || /\.(test|spec)\.[jt]s$/.test(key) || /test_[^/]*\.py$/.test(key)
  );
}

function diff(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as Record<string, FileDump>;
  const after = JSON.parse(readFileSync(afterPath, "utf8")) as Record<string, FileDump>;
  let changedTest = 0;
  let changedAny = 0;
  for (const key of Object.keys(before)) {
    const b = JSON.stringify(before[key]);
    const a = JSON.stringify(after[key]);
    if (a === b) continue;
    changedAny++;
    if (!isTestPath(key)) continue;
    // A test file whose chunks were only ADDED (remainder chunks) keeps every
    // old chunk verbatim; report files where an old chunk vanished or moved.
    const afterSet = new Set(after[key].map((t) => JSON.stringify(t)));
    const lost = before[key].filter((t) => !afterSet.has(JSON.stringify(t)));
    const beforeSet = new Set(before[key].map((t) => JSON.stringify(t)));
    const added = after[key].filter((t) => !beforeSet.has(JSON.stringify(t)));
    changedTest++;
    console.log(`${key}\n  lost/moved: ${JSON.stringify(lost)}\n  added: ${JSON.stringify(added)}`);
  }
  console.log(`files changed: ${changedAny}; test files changed: ${changedTest}`);
}

const args = process.argv.slice(2);
if (args[0] === "--diff") {
  diff(args[1], args[2]);
} else {
  const dump: Record<string, FileDump> = {};
  const rows = await measure(dump);
  console.log(rows.join("\n"));
  const at = args.indexOf("--dump");
  if (at >= 0) writeFileSync(args[at + 1], JSON.stringify(dump));
}
