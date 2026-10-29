#!/usr/bin/env node
// Re-read ledger hook (Claude Code). Agents re-read lines they already hold: the
// same file and an overlapping line range, a turn later, through sed, cat, Read
// or find_symbol — or raw lines a tea-rags chunk already returned. Core says
// "never call for what you have"; across turns that is not followed. This hook
// keeps a per-session ledger of the line ranges a call PRINTED and, when a new
// read asks for lines that are already ≥ 80% covered, adds ONE context line
// naming them. It never blocks: a false positive costs one line of context.
//
// Events (all on this one script):
//   PostToolUse  Read (offset/limit) · Bash cat / nl / sed -n A,Bp / head / tail /
//                grep -v <blank-line filter> of a file, with downstream head /
//                sed -n / tail limits · tea-rags results whose rows carry content
//                + startLine/endLine (an outline or a metaOnly row prints no lines)
//                → record. Edit / Write / MultiEdit / NotebookEdit and Bash writes
//                (`>`, `>>`, sed -i, perl -i, tee, mv, cp, rm; tree-moving git
//                commands drop the whole ledger) → invalidate.
//   PreToolUse   Read · Bash reads · find_symbol (symbol / symbols / relativePath)
//                → additionalContext note when the request is ≥ 80% covered.
//   UserPromptSubmit → next turn (the note names the turn).
//   SessionStart compact | clear → drop the session ledger (the lines left the
//                context); startup → prune ledgers idle for 7 days.
//
// State: $TEA_RAGS_HOOK_STATE_DIR (default: the plugin-data dir, else
// $TMPDIR/tea-rags-hooks — the store search-drift.sh uses), one directory per
// session id + subagent id (a subagent never saw the parent's reads). One small
// JSON file per tracked file (`f-<hash>`) and per served symbol (`s-<hash>`):
// O(1) lookup, ≤ 16 merged ranges per file, ≤ 512 tracked files per session. An
// entry remembers the file's mtime + size; a file changed since is never noted.
//
// Fail open, always: unparsable input, no session id, unwritable state — exit 0,
// no output.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const COVERAGE_THRESHOLD = 0.8;
export const MAX_RANGES_PER_FILE = 16;
export const MAX_FILES_PER_SESSION = 512;
const MAX_NOTES = 3;
const READ_DEFAULT_LIMIT = 2000;
const MAX_COUNTED_BYTES = 8 * 1024 * 1024;
const IDLE_LEDGER_MS = 7 * 24 * 3600 * 1000;
const TEA_RAGS_TOOL = /^mcp__.*tea-rags.*__(\w+)$/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ---------------------------------------------------------------- shell parsing

/** Words and operators of a shell command line; `$`, backticks and globs mark a word dynamic. */
export function tokenizeShell(command) {
  const tokens = [];
  let word = null;
  const flush = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  const extend = (text, dynamic = false) => {
    word ??= { word: "", dynamic: false };
    word.word += text;
    word.dynamic ||= dynamic;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      extend(command.slice(i + 1, end === -1 ? command.length : end));
      i = end === -1 ? command.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      let dynamic = false;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length) text += command[++j];
        else {
          if (command[j] === "$" || command[j] === "`") dynamic = true;
          text += command[j];
        }
      }
      extend(text, dynamic);
      i = j;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") i++;
      else extend(command[++i] ?? "");
    } else if (c === "$" || c === "`") {
      // $(…) / `…` / $VAR: one dynamic word, nested parentheses skipped.
      let j = i + 1;
      if (c === "$" && command[j] === "(") {
        let depth = 0;
        for (; j < command.length; j++) {
          if (command[j] === "(") depth++;
          else if (command[j] === ")" && --depth === 0) break;
        }
      } else if (c === "`") j = Math.max(command.indexOf("`", j), j);
      else while (j < command.length && /[\w{}?#@*!-]/.test(command[j])) j++;
      extend(command.slice(i, j + 1), true);
      i = c === "$" && command[i + 1] !== "(" ? j - 1 : j;
    } else if (c === " " || c === "\t") flush();
    else if (c === "\n" || c === ";" || c === "(" || c === ")") {
      flush();
      tokens.push({ op: c === "\n" ? ";" : c });
    } else if (c === "&" || c === "|") {
      flush();
      if (command[i + 1] === c) {
        tokens.push({ op: c + c });
        i++;
      } else if (c === "&" && command[i + 1] === ">") {
        tokens.push({ op: command[i + 2] === ">" ? ">>" : ">" });
        i += command[i + 2] === ">" ? 2 : 1;
      } else tokens.push({ op: c === "|" ? "|" : ";" });
    } else if (c === ">" || c === "<") {
      if (word && /^\d+$/.test(word.word)) word = null; // `2>` names a descriptor, not a word
      flush();
      let op = c;
      if (command[i + 1] === c) op += command[++i];
      if (command[i + 1] === "&") {
        i++;
        while (/\d|-/.test(command[i + 1] ?? "")) i++;
        continue; // `2>&1`: a duplication, no target
      }
      tokens.push({ op });
    } else {
      extend(c, c === "*" || c === "?" || c === "[" || c === "~");
    }
  }
  flush();
  return tokens;
}

/** Pipelines (lists split on `;` `&&` `||` `&`) of stages `{ words, redirects }`. */
export function shellPipelines(command) {
  const pipelines = [];
  let pipeline = [];
  let stage = { words: [], redirects: [] };
  let pendingRedirect = null;
  const endStage = () => {
    if (stage.words.length || stage.redirects.length) pipeline.push(stage);
    stage = { words: [], redirects: [] };
  };
  const endPipeline = () => {
    endStage();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  for (const token of tokenizeShell(command)) {
    if ("word" in token) {
      if (pendingRedirect) {
        stage.redirects.push({ op: pendingRedirect, target: token });
        pendingRedirect = null;
      } else stage.words.push(token);
    } else if (token.op === ">" || token.op === ">>" || token.op === "<" || token.op === "<<") {
      pendingRedirect = token.op;
    } else if (token.op === "|") endStage();
    else endPipeline();
  }
  endPipeline();
  return pipelines;
}

const SHELL_KEYWORDS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "{",
  "}",
  "!",
  "time",
  "command",
  "builtin",
  "exec",
  "sudo",
]);
const BLANK_FILTER = /^(\^\\s\*\$|\^\$|\^\[\[:space:\]\]\*\$|\^ \*\$|\^\[ \\t\]\*\$)$/;

/** The command words with leading keywords, `env` and VAR=value assignments removed. */
function commandWords(stage) {
  const words = [...stage.words];
  while (words.length) {
    const head = words[0];
    if (head.dynamic) return [];
    if (SHELL_KEYWORDS.has(head.word) || head.word === "env" || /^[A-Za-z_]\w*=/.test(head.word)) words.shift();
    else break;
  }
  return words;
}

function baseName(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Number from `-n N` / `-nN` / `-N`; `+K` for tail's from-line form. */
function countOption(words, start) {
  let count = null;
  let fromLine = false;
  const files = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i].word;
    let value = null;
    if (w === "-n" || w === "--lines") value = words[++i]?.word ?? null;
    else if (/^-n[+\d]/.test(w)) value = w.slice(2);
    else if (/^--lines=/.test(w)) value = w.slice(8);
    else if (/^-\d+$/.test(w)) value = w.slice(1);
    else if (/^-[cf]|^--bytes|^--follow/.test(w)) return null;
    else if (w.startsWith("-") && w !== "-") continue;
    else files.push(words[i]);
    if (value !== null) {
      fromLine = value.startsWith("+");
      count = Number.parseInt(value.replace(/^\+/, ""), 10);
      if (!Number.isFinite(count)) return null;
    }
  }
  return { count: count ?? 10, fromLine, files };
}

/** `sed -n` print scripts → line ranges; null when the script is anything else. */
function sedPrintRanges(script) {
  const ranges = [];
  for (const part of script
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(part);
    if (!m) return null;
    const start = Number(m[1]);
    ranges.push([start, m[2] === undefined ? start : m[2] === "$" ? Infinity : Number(m[2])]);
  }
  return ranges.length ? ranges : null;
}

/** sed words → `{ quiet, scripts, inPlace, files }`. */
function sedArgs(words) {
  let quiet = false;
  let inPlace = false;
  const scripts = [];
  const files = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i].word;
    if (w === "-e" || w === "--expression") scripts.push(words[++i]?.word ?? "");
    else if (w === "-n" || w === "--quiet" || w === "--silent") quiet = true;
    else if (/^-[A-Za-z]+$/.test(w) && !w.startsWith("-i")) {
      if (w.includes("n")) quiet = true;
      if (w.endsWith("e")) scripts.push(words[++i]?.word ?? "");
      if (w.includes("i")) inPlace = true;
    } else if (w.startsWith("-i") || w.startsWith("--in-place")) {
      inPlace = true;
      // BSD `sed -i ''`: the suffix is its own (empty) word.
      if (w === "-i" && words[i + 1]?.word === "") i++;
    } else if (w.startsWith("-")) continue;
    else if (!scripts.length) scripts.push(w);
    else files.push(words[i]);
  }
  return { quiet, scripts, inPlace, files };
}

/** A file read by a pipeline's first stage: `{ word, ranges: [[start, end]] }` (end Infinity = to EOF). */
function stageReads(words) {
  const name = baseName(words[0].word);
  const whole = (file) => ({ word: file, ranges: [[1, Infinity]] });
  const operands = (from) => words.slice(from).filter((w) => !w.word.startsWith("-") || w.word === "-");
  switch (name) {
    case "cat":
    case "nl":
    case "less":
    case "more":
    case "bat":
      return operands(1).map(whole);
    case "sed": {
      const args = sedArgs(words);
      if (!args.quiet || args.inPlace) return [];
      const ranges = sedPrintRanges(args.scripts.join(";"));
      return ranges ? args.files.map((file) => ({ word: file, ranges })) : [];
    }
    case "head": {
      const opt = countOption(words, 1);
      return opt && !opt.fromLine ? opt.files.map((file) => ({ word: file, ranges: [[1, opt.count]] })) : [];
    }
    case "tail": {
      const opt = countOption(words, 1);
      if (!opt) return [];
      return opt.files.map((file) => ({
        word: file,
        ranges: [opt.fromLine ? [opt.count, Infinity] : [-opt.count, Infinity]],
      }));
    }
    case "grep":
    case "egrep": {
      // `grep -v '^\s*$' <file>` prints the file minus its blank lines: a read.
      let invert = false;
      let pattern = null;
      const files = [];
      for (let i = 1; i < words.length; i++) {
        const w = words[i].word;
        if (w === "-e") pattern = words[++i]?.word ?? null;
        else if (/^-[A-Za-z]+$/.test(w)) {
          if (w.includes("v")) invert = true;
          if (/[lcLoqrRwx]/.test(w.slice(1))) return [];
        } else if (w.startsWith("-")) return [];
        else if (pattern === null) pattern = w;
        else files.push(words[i]);
      }
      return invert && pattern !== null && BLANK_FILTER.test(pattern) ? files.map(whole) : [];
    }
    default:
      return [];
  }
}

/** A downstream stage's effect on the printed lines: keep, a window, or "not a read". */
function downstreamWindow(words) {
  if (!words.length) return null;
  const name = baseName(words[0].word);
  if (name === "head") {
    const opt = countOption(words, 1);
    return opt && !opt.fromLine && !opt.files.length ? { first: opt.count } : null;
  }
  if (name === "tail") {
    const opt = countOption(words, 1);
    if (!opt || opt.files.length) return null;
    return opt.fromLine ? { from: opt.count } : { last: opt.count };
  }
  if (name === "sed") {
    const args = sedArgs(words);
    if (args.files.length || args.inPlace) return null;
    if (!args.quiet) return args.scripts.every((s) => /^s(.).*\1.*\1g?$/.test(s)) ? {} : null;
    const ranges = sedPrintRanges(args.scripts.join(";"));
    return ranges?.length === 1 ? { from: ranges[0][0], to: ranges[0][1] } : null;
  }
  if (name === "grep" || name === "egrep") {
    // Only an inverted filter keeps (most of) the lines; a pattern grep is a search.
    const flags = words
      .slice(1)
      .filter((w) => w.word.startsWith("-"))
      .map((w) => w.word);
    return flags.some((f) => /^-[A-Za-z]*v/.test(f)) && !flags.some((f) => /^-[A-Za-z]*[lcqo]/.test(f)) ? {} : null;
  }
  if (["cut", "cat", "nl", "expand", "fold", "less", "more"].includes(name)) return {};
  return null;
}

/**
 * Files a Bash command PRINTS, with line ranges: `[{ path, ranges: [[start, end]] }]`, end clamped to
 * the file. `lineCount(path)` → the file's line count, or null when it is not a readable file.
 */
export function bashReads(command, cwd, lineCount) {
  const reads = [];
  let dir = cwd;
  for (const pipeline of shellPipelines(command)) {
    const first = commandWords(pipeline[0]);
    if (!first.length) continue;
    if (pipeline.length === 1 && first[0].word === "cd") {
      const target = first[1];
      if (!target || target.dynamic) dir = null;
      else if (dir !== null || isAbsolute(target.word)) dir = resolve(dir ?? "/", target.word);
      continue;
    }
    if (dir === null) continue;
    if (pipeline.some((stage) => stage.redirects.some((r) => r.op === ">" || r.op === ">>"))) continue;
    let files = stageReads(first)
      .filter((read) => !read.word.dynamic && read.word.word !== "-")
      .map((read) => {
        const path = resolve(dir, read.word.word);
        const total = lineCount(path);
        if (total === null) return null;
        const ranges = read.ranges
          .map(([start, end]) => (start < 0 ? [Math.max(1, total + start + 1), total] : [start, Math.min(end, total)]))
          .filter(([start, end]) => start <= end);
        return { path, ranges, total };
      })
      .filter((read) => read && read.ranges.length);
    for (const stage of pipeline.slice(1)) {
      const window = downstreamWindow(commandWords(stage));
      if (window === null) {
        files = [];
        break;
      }
      files = applyWindow(files, window);
    }
    reads.push(...files.map(({ path, ranges }) => ({ path, ranges })));
  }
  return reads;
}

/** Restrict the concatenated output of `files` to a downstream window of output lines. */
function applyWindow(files, window) {
  const lines = files.reduce((sum, file) => sum + file.ranges.reduce((s, [a, b]) => s + b - a + 1, 0), 0);
  let from = 1;
  let to = lines;
  if (window.first !== undefined) to = Math.min(lines, window.first);
  if (window.last !== undefined) from = Math.max(1, lines - window.last + 1);
  if (window.from !== undefined) from = Math.max(from, window.from);
  if (window.to !== undefined) to = Math.min(to, window.to);
  const out = [];
  let offset = 0;
  for (const file of files) {
    const ranges = [];
    for (const [a, b] of file.ranges) {
      const len = b - a + 1;
      const lo = Math.max(from - offset, 1);
      const hi = Math.min(to - offset, len);
      if (lo <= hi) ranges.push([a + lo - 1, a + hi - 1]);
      offset += len;
    }
    if (ranges.length) out.push({ ...file, ranges });
  }
  return out;
}

const MAX_NUMBERED_LINES = 2000;

/** `[[n, n], …]` → merged consecutive ranges. */
function lineRuns(numbers) {
  const runs = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/**
 * Lines a numbered grep PRINTED, read back from its stdout: `<path>:<n>:` / `<path>-<n>-` hits of a
 * multi-file grep (path resolved against the cwd or a `cd` target of the command), and bare `<n>:` /
 * `<n>-` lines when the command runs exactly one single-file `grep -n` — otherwise they cannot be told
 * apart. `isFile(path)` → whether the path is a regular file.
 */
export function numberedGrepLines(command, stdout, cwd, isFile) {
  if (typeof stdout !== "string" || !stdout) return [];
  const dirs = [cwd];
  const singleFile = [];
  for (const pipeline of shellPipelines(command)) {
    const words = commandWords(pipeline[0]);
    if (!words.length) continue;
    if (words[0].word === "cd" && words[1] && !words[1].dynamic) {
      dirs.push(resolve(dirs[dirs.length - 1], words[1].word));
    }
    const name = baseName(words[0].word);
    if (name !== "grep" && name !== "egrep") continue;
    const flags = words
      .slice(1)
      .filter((w) => /^-[A-Za-z]+$/.test(w.word))
      .map((w) => w.word.slice(1))
      .join("");
    if (!flags.includes("n") || /[rRlcLqH]/.test(flags)) {
      if (flags.includes("n")) singleFile.push(null);
      continue;
    }
    // `-A 3` / `-m 5` / `-e PAT` / `-f FILE` take the next word as their value.
    const operands = words
      .slice(1)
      .filter((w, i, all) => !w.word.startsWith("-") && !/^-[ABCmef]$/.test(all[i - 1]?.word ?? ""));
    const patternGiven = words.some((w) => w.word === "-e" || w.word === "-f");
    const files = operands.slice(patternGiven ? 0 : 1);
    singleFile.push(files.length === 1 && !files[0].dynamic ? resolve(dirs[dirs.length - 1], files[0].word) : null);
  }
  const byPath = new Map();
  const add = (path, n) => {
    const list = byPath.get(path) ?? [];
    list.push(n);
    byPath.set(path, list);
  };
  const resolved = new Map();
  const lone = singleFile.length === 1 ? singleFile[0] : null;
  for (const line of stdout.split("\n").slice(0, MAX_NUMBERED_LINES)) {
    const hit = /^([^\s:]+?)([:-])(\d+)\2/.exec(line);
    if (hit && /[/.]/.test(hit[1])) {
      if (!resolved.has(hit[1])) resolved.set(hit[1], dirs.map((d) => resolve(d, hit[1])).find(isFile) ?? null);
      const path = resolved.get(hit[1]);
      if (path) add(path, Number(hit[3]));
      continue;
    }
    const bare = lone && /^(\d+)[:-]/.exec(line);
    if (bare) add(lone, Number(bare[1]));
  }
  return [...byPath].map(([path, numbers]) => ({ path, ranges: lineRuns(numbers) }));
}

const TREE_MOVING_GIT = new Set([
  "checkout",
  "switch",
  "restore",
  "reset",
  "stash",
  "pull",
  "merge",
  "rebase",
  "apply",
  "am",
  "cherry-pick",
  "revert",
  "clean",
]);

/** Files a Bash command may WRITE: `{ paths, all }` — `all` when it can move the whole tree. */
export function bashWrites(command, cwd) {
  const paths = new Set();
  let all = false;
  let dir = cwd;
  for (const pipeline of shellPipelines(command)) {
    for (const stage of pipeline) {
      const words = commandWords(stage);
      const add = (word) => {
        if (word.dynamic) all = true;
        else if (dir !== null && word.word !== "/dev/null") paths.add(resolve(dir, word.word));
      };
      for (const r of stage.redirects) if (r.op === ">" || r.op === ">>") add(r.target);
      if (!words.length) continue;
      const name = baseName(words[0].word);
      const operands = words.slice(1).filter((w) => !w.word.startsWith("-"));
      if (name === "cd" && pipeline.length === 1) {
        const target = words[1];
        dir =
          !target || target.dynamic || dir === null
            ? target && isAbsolute(target.word)
              ? target.word
              : null
            : resolve(dir, target.word);
      } else if (name === "sed") {
        const args = sedArgs(words);
        if (args.inPlace) args.files.forEach(add);
      } else if (name === "perl" && words.some((w) => /^-\w*i/.test(w.word))) operands.slice(1).forEach(add);
      else if (["tee", "rm", "mv", "cp", "truncate", "dd", "patch"].includes(name)) operands.forEach(add);
      else if (
        name === "git" &&
        TREE_MOVING_GIT.has(words.find((w, i) => i > 0 && !w.word.startsWith("-"))?.word ?? "")
      ) {
        all = true;
      }
    }
  }
  return { paths: [...paths], all };
}

// ---------------------------------------------------------------- tea-rags results

/** The text of an MCP tool response: a string, an array of content blocks, or `{ content }`. */
function mcpText(response) {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response.map((block) => (typeof block === "string" ? block : (block?.text ?? ""))).join("\n");
  }
  if (response && Array.isArray(response.content)) return mcpText(response.content);
  if (response && typeof response === "object") return JSON.stringify(response);
  return "";
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Result rows as flat objects: arrays of `{ payload }` / flat rows, or columnar `{ columns, rows }`. */
function resultRows(results) {
  if (Array.isArray(results)) return results.map((row) => ({ ...row, ...(row?.payload ?? {}) }));
  if (results && Array.isArray(results.columns) && Array.isArray(results.rows)) {
    const names = results.columns.map((c) => String(c).replace(/^payload\./, ""));
    return results.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row?.[i]])));
  }
  return [];
}

/** Rows of a tea-rags result that PRINTED code lines: `[{ relativePath, startLine, endLine, symbolId }]`. */
export function servedRows(response) {
  let parsed;
  try {
    parsed = JSON.parse(mcpText(response));
  } catch {
    return [];
  }
  if (!parsed || parsed.isError) return [];
  return resultRows(parsed.results).filter((row) => {
    const { relativePath, startLine, endLine, content } = row;
    if (typeof relativePath !== "string" || typeof content !== "string") return false;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) return false;
    // An outline lists members; a body prints (nearly) every line of its range.
    return countLines(content) >= COVERAGE_THRESHOLD * (endLine - startLine + 1);
  });
}

// ---------------------------------------------------------------- ledger store

function hash(text) {
  return createHash("md5").update(text).digest("hex").slice(0, 20);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function fileStamp(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

/** Line count of a regular file, null when it is not one (or too large to count). */
export function fileLineCount(path) {
  const stamp = fileStamp(path);
  if (!stamp || stamp.size > MAX_COUNTED_BYTES) return null;
  try {
    return countLines(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Merge `[start, end, turn, tool]` ranges; a merged range keeps the latest source. Insertion order = age. */
function mergeRanges(ranges) {
  const sorted = ranges.map((r, age) => ({ r, age })).sort((a, b) => a.r[0] - b.r[0]);
  const merged = [];
  for (const { r, age } of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last.r[1] + 1) {
      last.r = [last.r[0], Math.max(last.r[1], r[1]), ...(age > last.age ? r.slice(2) : last.r.slice(2))];
      last.age = Math.max(last.age, age);
    } else merged.push({ r: [...r], age });
  }
  return merged.sort((a, b) => a.age - b.age).map((m) => m.r);
}

export class RereadLedger {
  constructor(dir) {
    this.dir = dir;
  }

  fileEntryPath(path) {
    return join(this.dir, `f-${hash(path)}`);
  }

  symbolEntryPath(symbolId) {
    return join(this.dir, `s-${hash(symbolId)}`);
  }

  turn() {
    const n = Number.parseInt(readFileSync(join(this.dir, "turn"), "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  safeTurn() {
    try {
      return this.turn();
    } catch {
      return 1;
    }
  }

  nextTurn() {
    mkdirSync(this.dir, { recursive: true });
    let turn;
    try {
      turn = this.turn();
    } catch {
      turn = 0; // first prompt of the session
    }
    writeJson(join(this.dir, "turn"), turn + 1);
  }

  /** Valid entry of a file (stamp unchanged), else null — a stale entry is removed. */
  entry(path) {
    const file = this.fileEntryPath(path);
    const entry = readJson(file);
    if (!entry || entry.path !== path) return null;
    const stamp = fileStamp(path);
    if (!stamp || stamp.mtimeMs !== entry.mtimeMs || stamp.size !== entry.size) {
      rmSync(file, { force: true });
      return null;
    }
    return entry;
  }

  record(path, ranges, tool) {
    const stamp = fileStamp(path);
    if (!stamp || !ranges.length) return;
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileEntryPath(path);
    let entry = this.entry(path);
    if (!entry) {
      if (readdirSync(this.dir).filter((name) => name.startsWith("f-")).length >= MAX_FILES_PER_SESSION) return;
      entry = { path, ...stamp, ranges: [] };
    }
    const turn = this.safeTurn();
    const merged = mergeRanges([...entry.ranges, ...ranges.map(([s, e]) => [s, e, turn, tool])]);
    entry.ranges = merged.slice(-MAX_RANGES_PER_FILE);
    writeJson(file, entry);
  }

  recordSymbol(symbolId, path, start, end, tool) {
    mkdirSync(this.dir, { recursive: true });
    writeJson(this.symbolEntryPath(symbolId), { symbolId, path, start, end, turn: this.safeTurn(), tool });
  }

  symbol(symbolId) {
    const entry = readJson(this.symbolEntryPath(symbolId));
    if (!entry || entry.symbolId !== symbolId) return null;
    // Valid only while the file's lines are still on record (unchanged since).
    const file = this.entry(entry.path);
    return file && coverage(file.ranges, entry.start, entry.end).fraction >= COVERAGE_THRESHOLD ? entry : null;
  }

  forget(path) {
    rmSync(this.fileEntryPath(path), { force: true });
  }

  clear() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Coverage of `[start, end]` by served ranges: fraction + the covered pieces with their source. */
export function coverage(ranges, start, end) {
  const pieces = [];
  let covered = 0;
  for (const [a, b, turn, tool] of mergeRanges(ranges).sort((x, y) => x[0] - y[0])) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (lo > hi) continue;
    covered += hi - lo + 1;
    pieces.push({ start: lo, end: hi, turn, tool });
  }
  return { fraction: covered / (end - start + 1), pieces };
}

// ---------------------------------------------------------------- events

function display(path, cwd) {
  if (!cwd) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function describe(pieces, path, cwd) {
  const spans = pieces.map((p) => (p.start === p.end ? `${p.start}` : `${p.start}–${p.end}`));
  const source = pieces.reduce((best, p) => (p.end - p.start > best.end - best.start ? p : best), pieces[0]);
  const noun = pieces.length === 1 && pieces[0].start === pieces[0].end ? "line" : "lines";
  return `${noun} ${spans.slice(0, 3).join(", ")}${spans.length > 3 ? ", …" : ""} of ${display(path, cwd)} already returned (turn ${source.turn}, ${source.tool})`;
}

function readToolRange(input, response) {
  const file = response && typeof response === "object" ? response.file : null;
  if (file && Number.isInteger(file.startLine) && Number.isInteger(file.numLines) && file.numLines > 0) {
    return [file.startLine, file.startLine + file.numLines - 1];
  }
  const offset = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 1;
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : READ_DEFAULT_LIMIT;
  return [offset, offset + limit - 1];
}

/** Requests of a pre-call: `{ files: [{ path, ranges }], symbols: [symbolId] }`. */
function requests(tool, input, cwd, lineCount) {
  const clamp = (path, ranges) => {
    const total = lineCount(path);
    if (total === null) return null;
    const clamped = ranges.map(([s, e]) => [s, Math.min(e, total)]).filter(([s, e]) => s <= e);
    return clamped.length ? { path, ranges: clamped } : null;
  };
  if (tool === "Read") {
    const path = input.file_path ?? input.path;
    if (typeof path !== "string" || (!cwd && !isAbsolute(path))) return { files: [], symbols: [] };
    const read = clamp(resolve(cwd ?? "/", path), [readToolRange(input, null)]);
    return { files: read ? [read] : [], symbols: [] };
  }
  if (tool === "Bash") {
    return typeof input.command === "string" && cwd
      ? { files: bashReads(input.command, cwd, lineCount), symbols: [] }
      : { files: [], symbols: [] };
  }
  const teaRags = TEA_RAGS_TOOL.exec(tool)?.[1];
  if (teaRags !== "find_symbol") return { files: [], symbols: [] };
  const root = typeof input.path === "string" ? input.path : cwd;
  const files = [];
  const symbols = [];
  const asked = [input.relativePath, input.symbol, ...(Array.isArray(input.symbols) ? input.symbols : [])].filter(
    (s) => typeof s === "string",
  );
  for (const item of asked) {
    const path = root ? resolve(root, item) : null;
    const read = path && /[/.]/.test(item) ? clamp(path, [[1, Infinity]]) : null;
    if (read) files.push(read);
    else symbols.push(item);
  }
  return { files, symbols };
}

/** One hook event → the JSON to print, or null. */
export function handleHookEvent(input, { stateDir, lineCount = fileLineCount }) {
  const event = String(input?.hook_event_name ?? "").toLowerCase();
  const sid = String(input?.session_id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!event || !sid) return null;
  const agent =
    typeof input.agent_id === "string" && input.agent_id ? `~${input.agent_id.replace(/[^A-Za-z0-9_.-]/g, "_")}` : "";
  const ledger = new RereadLedger(join(stateDir, `reread-claude-${sid}${agent}`));
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
  const tool = String(input.tool_name ?? "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  if (event === "userpromptsubmit") {
    ledger.nextTurn();
    return null;
  }
  if (event === "sessionstart") {
    if (input.source === "compact" || input.source === "clear") ledger.clear();
    else if (input.source === "startup") pruneIdleLedgers(stateDir);
    return null;
  }
  if (event === "posttooluse") {
    recordPost(ledger, tool, toolInput, input.tool_response, cwd, lineCount);
    return null;
  }
  if (event !== "pretooluse") return null;

  const { files, symbols } = requests(tool, toolInput, cwd, lineCount);
  const notes = [];
  for (const symbolId of symbols) {
    const entry = ledger.symbol(symbolId);
    if (entry) {
      notes.push(
        `${symbolId}: ${describe([{ start: entry.start, end: entry.end, turn: entry.turn, tool: entry.tool }], entry.path, cwd)}`,
      );
    }
  }
  for (const { path, ranges } of files) {
    const entry = ledger.entry(path);
    if (!entry) continue;
    for (const [start, end] of ranges) {
      const { fraction, pieces } = coverage(entry.ranges, start, end);
      if (fraction >= COVERAGE_THRESHOLD) notes.push(describe(pieces, path, cwd));
    }
  }
  if (!notes.length) return null;
  const shown = [...new Set(notes)].slice(0, MAX_NOTES);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `tea-rags: ${shown.join("; ")} — answer from them.`,
    },
  };
}

function recordPost(ledger, tool, input, response, cwd, lineCount) {
  if (EDIT_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof path === "string" && (cwd || isAbsolute(path))) ledger.forget(resolve(cwd ?? "/", path));
    return;
  }
  if (tool === "Read") {
    const path = input.file_path ?? input.path;
    if (typeof path !== "string" || (!cwd && !isAbsolute(path))) return;
    const abs = resolve(cwd ?? "/", path);
    const total = lineCount(abs);
    if (total === null) return;
    const [start, end] = readToolRange(input, response);
    if (start <= Math.min(end, total)) ledger.record(abs, [[start, Math.min(end, total)]], "Read");
    return;
  }
  if (tool === "Bash") {
    if (typeof input.command !== "string" || !cwd) return;
    const writes = bashWrites(input.command, cwd);
    if (writes.all) {
      ledger.clear();
      return;
    }
    writes.paths.forEach((path) => ledger.forget(path));
    const stdout = response && typeof response === "object" ? response.stdout : null;
    const printed = [
      ...bashReads(input.command, cwd, lineCount),
      ...numberedGrepLines(input.command, stdout, cwd, (path) => fileStamp(path) !== null),
    ];
    for (const read of printed) {
      if (!writes.paths.includes(read.path)) ledger.record(read.path, read.ranges, "Bash");
    }
    return;
  }
  const teaRags = TEA_RAGS_TOOL.exec(tool)?.[1];
  if (!teaRags) return;
  const root = typeof input.path === "string" ? input.path : cwd;
  if (!root) return;
  for (const row of servedRows(response)) {
    const path = resolve(root, row.relativePath);
    ledger.record(path, [[row.startLine, row.endLine]], teaRags);
    if (typeof row.symbolId === "string" && row.symbolId) {
      ledger.recordSymbol(row.symbolId, path, row.startLine, row.endLine, teaRags);
    }
  }
}

function pruneIdleLedgers(stateDir) {
  const now = Date.now();
  let names;
  try {
    names = readdirSync(stateDir).filter((name) => name.startsWith("reread-"));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(join(stateDir, name)).mtimeMs > IDLE_LEDGER_MS) {
        rmSync(join(stateDir, name), { recursive: true, force: true });
      }
    } catch {
      // another session pruned it first
    }
  }
}

function main() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const stateDir =
    process.env.TEA_RAGS_HOOK_STATE_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    process.env.PLUGIN_DATA ||
    join(process.env.TMPDIR || "/tmp", "tea-rags-hooks");
  try {
    const out = handleHookEvent(JSON.parse(raw), { stateDir });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // fail open: the tool call proceeds untouched
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
