#!/usr/bin/env node
// Re-read ledger hook (Claude Code, Codex, Cursor). Agents re-read lines they already hold: the
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
//                Read · Bash reads of an INDEXED SOURCE file (`tea-rags project
//                indexed`, the test search-drift.sh runs; never a standard-zone.ere
//                path — config / DSL / routes / migrations / specs / data) → one
//                nudge line naming find_symbol(relativePath:), once per file per
//                turn, never beside the re-read note or a search-drift SEARCH
//                deny (reads are never denied, bd tea-rags-mcp-nxg76: on every
//                harness this nudge is the only read steering). A slice of < 80% of
//                the file names instead the outline ids whose ` L<a>-<b>` covers it
//                as a literal find_symbol(symbols:[…]) — find_symbol(symbol:"<Class>")
//                for a container header only — from ONE `tea-rags call find_symbol
//                {symbols:[path], metaOnly}` cached per session; an outline without
//                ranges for those lines keeps the generic nudge.
//   PostToolUse  Grep content / numbered shell grep hits in indexed, non-zone files
//                (≤ 3, one outline call) → one note naming their enclosing ids as a
//                literal find_symbol(symbols:[…]). Claude Code and Cursor only.
//   UserPromptSubmit → next turn (the note names the turn).
//   SessionStart compact | clear → drop the session ledger (the lines left the
//                context); startup → prune ledgers idle for 7 days.
//
// One script, three harnesses (`--harness claude|codex|cursor`, default claude;
// Codex and Cursor ship this file byte-identical). `harnessEvent` maps each
// payload onto the Claude shape above; `harnessAnswer` renders the note:
//   claude — as above; hookSpecificOutput.additionalContext.
//   codex  — PreToolUse / PostToolUse(shell: Bash|shell|exec_command, argv or
//            string command, workdir; tea-rags MCP under either spelling),
//            UserPromptSubmit, SessionStart; hookSpecificOutput.additionalContext
//            (PreToolUseHookSpecificOutputWire, codex-cli 0.162.1); no grep-hit
//            note (a PostToolUse context channel is not established). No Read tool;
//            apply_patch edits invalidate through the mtime + size stamp.
//   cursor — preToolUse(Shell|Read) notes as {"permission":"allow",
//            "additional_context"}; postToolUse(Shell) and afterMCPExecution
//            (tea-rags server) record, the grep-hit note rides postToolUse
//            as {"additional_context"}; beforeSubmitPrompt → next turn +
//            {"continue":true}; ledgers idle 7 days are pruned there (no
//            sessionStart keyed like the tool events). A Read result is not
//            recorded: its hook input carries no line range. Every Cursor exit
//            prints JSON (a permission hook with invalid stdout blocks).
// Session key: session_id, else Cursor's conversation_id — search-drift.sh's.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COVERAGE_THRESHOLD = 0.8;
export const MAX_RANGES_PER_FILE = 16;
export const MAX_FILES_PER_SESSION = 512;
const MAX_NOTES = 3;
const READ_DEFAULT_LIMIT = 2000;
const MAX_COUNTED_BYTES = 8 * 1024 * 1024;
const IDLE_LEDGER_MS = 7 * 24 * 3600 * 1000;
const INDEXED_LOOKUP_TIMEOUT_MS = 1500;
// The outline call shares the hook's 8 s budget with the index lookup.
const OUTLINE_LOOKUP_TIMEOUT_MS = 5000;
const MAX_OUTLINE_FILES = 3;
const MAX_NAMED_IDS = 8;
// search-drift.sh thresholds: a streak of 3 concept searches, one deny per 120 s. Reads never count.
const DRIFT_SEARCH_STREAK = 3;
const DRIFT_COOLDOWN_SEC = 120;
const DRIFT_JUST_DENIED_SEC = 5;
// Codex code mode spells a nested MCP tool as a JS identifier: `mcp__tea_rags__<tool>`.
const TEA_RAGS_TOOL = /^mcp__.*tea[-_]rags.*__(\w+)$/;
const HARNESSES = new Set(["claude", "codex", "cursor"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "Shell"]);
/** cursor-agent refuses a hook's `additional_context` past this (HookAdditionalContextTooLargeError). */
const CURSOR_CONTEXT_MAX_CHARS = 10000;
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
  return printedNumberedLines(stdout, dirs, singleFile.length === 1 ? singleFile[0] : null, isFile);
}

/**
 * `<path>:<n>:` / `<path>-<n>-` lines of a numbered search's output (path resolved against `dirs`,
 * the first that names a file wins), and bare `<n>:` / `<n>-` lines of `lone` — the one file searched,
 * when known. A line counts only when it is that line of the file now.
 */
function printedNumberedLines(stdout, dirs, lone, isFile) {
  const byPath = new Map();
  const sources = new Map();
  const add = (path, n, content) => {
    if (!sources.has(path)) sources.set(path, sourceLines(path));
    if (sources.get(path)?.[n - 1] !== content) return;
    const list = byPath.get(path) ?? [];
    list.push(n);
    byPath.set(path, list);
  };
  const resolved = new Map();
  for (const line of stdout.split("\n").slice(0, MAX_NUMBERED_LINES)) {
    const hit = /^([^\s:]+?)([:-])(\d+)\2/.exec(line);
    if (hit && /[/.]/.test(hit[1])) {
      if (!resolved.has(hit[1])) resolved.set(hit[1], dirs.map((d) => resolve(d, hit[1])).find(isFile) ?? null);
      const path = resolved.get(hit[1]);
      if (path) add(path, Number(hit[3]), line.slice(hit[0].length));
      continue;
    }
    const bare = lone && /^(\d+)[:-]/.exec(line);
    if (bare) add(lone, Number(bare[1]), line.slice(bare[0].length));
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
  if (failedResponse(response)) return [];
  let parsed;
  try {
    parsed = response?.structuredContent ?? JSON.parse(mcpText(response));
  } catch {
    return [];
  }
  if (!parsed || failedResponse(parsed)) return [];
  return resultRows(parsed.results).filter((row) => {
    const { relativePath, startLine, endLine, content } = row;
    if (typeof relativePath !== "string" || typeof content !== "string") return false;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) return false;
    // Outlines are addresses. Other content still needs source-line evidence before recording.
    return row.kind !== "outline" && row.kind !== "directory";
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

/** A failed or interrupted result cannot prove a read succeeded, even when it carries metadata. */
function failedResponse(response) {
  if (!response || typeof response !== "object") return false;
  return Boolean(
    response.isError ||
    response.is_error ||
    response.error ||
    response.interrupted ||
    response.timedOut ||
    response.timed_out ||
    response.success === false ||
    [response.exit_code, response.exitCode].some((code) => code !== null && code !== undefined && Number(code) !== 0),
  );
}

/** A bounded snapshot of the source for matching delivered lines; unreadable files prove nothing. */
function sourceLines(path) {
  const stamp = fileStamp(path);
  if (!stamp || stamp.size > MAX_COUNTED_BYTES) return null;
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Requested source lines actually present, in order, in delivered text; omitted lines stay unknown. */
function deliveredRanges(path, ranges, text) {
  if (typeof text !== "string" || !text) return [];
  const source = sourceLines(path);
  if (!source) return [];
  const printed = text.split(/\r?\n/);
  if (printed[printed.length - 1] === "") printed.pop();
  const positions = new Map();
  printed.forEach((line, index) => {
    // `nl` decorates a line but still delivers the complete source text.
    const raw = line.replace(/^\s*\d+\t/, "");
    const offsets = positions.get(raw) ?? [];
    offsets.push(index);
    positions.set(raw, offsets);
  });
  let cursor = 0;
  const lines = [];
  for (const [start, end] of ranges) {
    for (let line = start; line <= Math.min(end, source.length); line++) {
      const offsets = positions.get(source[line - 1]);
      while (offsets?.length && offsets[0] < cursor) offsets.shift();
      if (!offsets?.length) continue;
      cursor = offsets.shift() + 1;
      lines.push(line);
    }
  }
  return lineRuns(lines);
}

/** A class header is proven only inside the explicit printed header spans, never the class span. */
function deliveredHeaderRanges(path, row) {
  const headers = [...row.content.matchAll(/^── header (\d+)[–-](\d+) ──(?:\r?\n|$)/gm)];
  return headers.flatMap((header, index) => {
    const start = Number(header[1]);
    const end = Number(header[2]);
    if (start < row.startLine || end > row.endLine || end < start) return [];
    const text = row.content.slice(header.index + header[0].length, headers[index + 1]?.index);
    return deliveredRanges(path, [[start, end]], text);
  });
}

/** Merge `[start, end, turn, tool]` ranges; a merged range keeps the latest source. Insertion order = age. */
/**
 * Union of `[start, end, ...label]` ranges given oldest first, as disjoint ranges, oldest
 * first. A range keeps the label (turn, tool) of the call that served it: a newer range
 * takes over only the ranges it covers whole (the same lines served again) and claims the
 * lines no range holds yet — a grep line inside a Read range never relabels the Read.
 * Abutting ranges with the same label coalesce.
 */
function mergeRanges(ranges) {
  let held = [];
  ranges.forEach((r, age) => {
    const [start, end] = r;
    held = held.filter((h) => h.r[0] < start || h.r[1] > end);
    let next = start;
    for (const h of held.filter((x) => x.r[1] >= start && x.r[0] <= end).sort((a, b) => a.r[0] - b.r[0])) {
      if (h.r[0] > next) held.push({ r: [next, h.r[0] - 1, ...r.slice(2)], age });
      next = Math.max(next, h.r[1] + 1);
    }
    if (next <= end) held.push({ r: [next, end, ...r.slice(2)], age });
  });
  const sameLabel = (a, b) => a.length === b.length && a.every((v, i) => i < 2 || v === b[i]);
  const coalesced = [];
  for (const h of held.sort((a, b) => a.r[0] - b.r[0])) {
    const last = coalesced[coalesced.length - 1];
    if (last && h.r[0] === last.r[1] + 1 && sameLabel(last.r, h.r)) {
      last.r = [last.r[0], h.r[1], ...last.r.slice(2)];
      last.age = Math.max(last.age, h.age);
    } else coalesced.push({ ...h, r: [...h.r] });
  }
  return coalesced.sort((a, b) => a.age - b.age).map((h) => h.r);
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

  /** Index-nudge state of a file: `{ indexed: false }`, or `{ relativePath, turn }` of its last nudge. */
  nudgeEntry(path) {
    const entry = readJson(join(this.dir, `n-${hash(path)}`));
    return entry && entry.path === path ? entry : null;
  }

  recordNudge(path, state) {
    mkdirSync(this.dir, { recursive: true });
    writeJson(join(this.dir, `n-${hash(path)}`), { path, ...state });
  }

  /** Cached outline entries of a file (stamp unchanged since they were fetched), else null. */
  outline(path) {
    const entry = readJson(join(this.dir, `o-${hash(path)}`));
    if (!entry || entry.path !== path || !Array.isArray(entry.entries)) return null;
    const stamp = fileStamp(path);
    return stamp && stamp.mtimeMs === entry.mtimeMs && stamp.size === entry.size ? entry.entries : null;
  }

  recordOutline(path, entries) {
    const stamp = fileStamp(path);
    if (!stamp) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeJson(join(this.dir, `o-${hash(path)}`), { path, ...stamp, entries });
    } catch {
      // the cache is best-effort: the next event fetches again
    }
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

/** A shell command as one string: Codex may send an argv array, `[bash, -lc, <code>]` → `<code>`. */
function shellCommandText(command) {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.length) return null;
  const argv = command.map(String);
  if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-[a-z]*c$/.test(argv[1])) return argv[2];
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** A JSON string Cursor hands over (tool_input, result_json) → its value; anything else as is. */
function parsedJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * One harness payload → the Claude-shaped event the ledger reads
 * (`{ hook_event_name, session_id, agent_id, cwd, tool_name, tool_input, tool_response, source }`), or
 * null when the event carries nothing for the ledger. Shell tools become `Bash` with a string command,
 * tea-rags MCP tools `mcp__tea-rags__<tool>`.
 */
export function harnessEvent(input, harness) {
  if (!input || typeof input !== "object") return null;
  const event = String(input.hook_event_name ?? "").toLowerCase();
  const sessionId = input.session_id ?? input.conversation_id;
  const base = {
    hook_event_name: event,
    session_id: sessionId,
    agent_id: input.agent_id,
    cwd: input.cwd ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined),
    source: input.source,
  };
  if (harness === "claude") return { ...input, ...base };
  if (event === "userpromptsubmit" || event === "beforesubmitprompt") {
    return { ...base, hook_event_name: "userpromptsubmit" };
  }
  if (event === "sessionstart") return harness === "codex" ? base : null;
  let tool = String(input.tool_name ?? "");
  let toolInput = parsedJson(input.tool_input);
  toolInput = toolInput && typeof toolInput === "object" ? { ...toolInput } : {};
  let response = input.tool_response;
  let hookEvent = event;
  if (event === "aftermcpexecution") {
    // Cursor: bare tool_name + mcp_server_name; the result is a JSON string of the MCP CallToolResult.
    if (!/tea[-_]rags/.test(String(input.mcp_server_name ?? "")) && !TEA_RAGS_TOOL.test(tool)) return null;
    if (!TEA_RAGS_TOOL.test(tool)) tool = `mcp__tea-rags__${tool}`;
    response = parsedJson(input.result_json);
    hookEvent = "posttooluse";
  } else if (event === "posttooluse" && harness === "cursor") {
    // Read: no line range in the hook input, so recording it could claim lines never printed.
    // MCP:<tool>: recorded by afterMCPExecution, which names the server.
    if (tool !== "Shell") return null;
    response = parsedJson(input.tool_output);
  } else if (event !== "pretooluse" && event !== "posttooluse") {
    return null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = shellCommandText(toolInput.command ?? (harness === "codex" ? toolInput.cmd : undefined));
    if (!command) return null;
    const dir = toolInput.workdir ?? toolInput.cwd;
    if (typeof dir === "string" && dir) base.cwd = base.cwd ? resolve(base.cwd, dir) : dir;
    tool = "Bash";
    toolInput = { command };
    // Native Codex PostToolUse delivers shell stdout directly as a string.
    if (harness === "codex" && hookEvent === "posttooluse" && typeof response === "string") {
      response = { stdout: response };
    }
  }
  return { ...base, hook_event_name: hookEvent, tool_name: tool, tool_input: toolInput, tool_response: response };
}

/** The ledger's answer → what the harness prints: the note in its non-blocking channel. */
export function harnessAnswer(harness, event, lines) {
  const context = lines.join("\n");
  if (harness === "cursor") {
    if (event === "pretooluse") {
      return context
        ? { permission: "allow", additional_context: context.slice(0, CURSOR_CONTEXT_MAX_CHARS) }
        : { permission: "allow" };
    }
    if (event === "posttooluse" && context) return { additional_context: context.slice(0, CURSOR_CONTEXT_MAX_CHARS) };
    return event === "userpromptsubmit" || event === "beforesubmitprompt" ? { continue: true } : {};
  }
  const hookEventName = event === "posttooluse" ? "PostToolUse" : "PreToolUse";
  return context ? { hookSpecificOutput: { hookEventName, additionalContext: context } } : null;
}

/** One hook event → the JSON to print, or null. */
export function handleHookEvent(
  raw,
  {
    stateDir,
    harness = "claude",
    lineCount = fileLineCount,
    indexedLookup = cliIndexedLookup,
    outlineLookup = cliOutlines,
  },
) {
  const rawEvent = String(raw?.hook_event_name ?? "").toLowerCase();
  const lines = ledgerLines(harnessEvent(raw, harness), { stateDir, harness, lineCount, indexedLookup, outlineLookup });
  return harnessAnswer(harness, rawEvent, lines);
}

/** The ledger's lines for one Claude-shaped event (records and turn moves answer none). */
function ledgerLines(input, { stateDir, harness, lineCount, indexedLookup, outlineLookup }) {
  const event = String(input?.hook_event_name ?? "");
  const sid = String(input?.session_id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!event || !sid) return [];
  const agent =
    typeof input.agent_id === "string" && input.agent_id ? `~${input.agent_id.replace(/[^A-Za-z0-9_.-]/g, "_")}` : "";
  const ledger = new RereadLedger(join(stateDir, `reread-${harness}-${sid}${agent}`));
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
  const tool = String(input.tool_name ?? "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  if (event === "userpromptsubmit") {
    ledger.nextTurn();
    // Cursor has no sessionStart keyed like its tool events: prune on the prompt instead.
    if (harness === "cursor") pruneIdleLedgers(stateDir);
    return [];
  }
  if (event === "sessionstart") {
    if (input.source === "compact" || input.source === "clear") ledger.clear();
    else if (input.source === "startup") pruneIdleLedgers(stateDir);
    return [];
  }
  if (event === "posttooluse") {
    recordPost(ledger, tool, toolInput, input.tool_response, cwd, lineCount);
    // Codex: a PostToolUse additionalContext is not established for that harness (harness/codex/README.md
    // names the PreToolUse wire only), so the hit note ships to Claude Code and Cursor.
    if (harness === "codex" || !cwd || (tool !== "Grep" && tool !== "Bash")) return [];
    const note = grepHitNote(ledger, tool, toolInput, input.tool_response, cwd, outlineLookup);
    return note ? [note] : [];
  }
  if (event !== "pretooluse") return [];

  const { files, symbols } = requests(tool, toolInput, cwd, lineCount);
  const notes = [];
  const held = new Set();
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
      if (fraction >= COVERAGE_THRESHOLD) {
        notes.push(describe(pieces, path, cwd));
        held.add(path);
      }
    }
  }
  const lines = [];
  if (notes.length) lines.push(`tea-rags: ${[...new Set(notes)].slice(0, MAX_NOTES).join("; ")} — answer from them.`);
  const searchDenied = tool === "Bash" && driftSearchDenyMayFire(stateDir, harness, sid, toolInput.command, cwd);
  if ((tool === "Read" || tool === "Bash") && !searchDenied) {
    const fresh = files.map((f) => f.path).filter((path) => !held.has(path));
    const hit = indexedSourceHit(ledger, fresh, cwd, indexedLookup);
    if (hit) {
      const ranges = files.find((f) => f.path === hit.path)?.ranges ?? [];
      lines.push(
        rangeNudge(ledger, hit, ranges, cwd, lineCount, outlineLookup) ?? indexedSourceNudge(hit.relativePath),
      );
    }
  }
  return lines;
}

/**
 * Whether a shell command is a concept search the way search-drift.sh counts one: grep / egrep /
 * fgrep / rg / ag / ack / git grep starting a command, with an alternation (`a|b`, `a\|b`, two -e)
 * and no -F, not scoped to a standard-zone path (the cwd prefix stripped first).
 */
function conceptShellSearch(command, cwd) {
  const searchStart =
    /(^|[;&(`]|\|\||\$\()\s*(([A-Za-z_]\w*=\S*|sudo|command|env)\s+)*(grep|egrep|fgrep|rg|ag|ack|git\s+grep)(\s|$)/;
  if (!searchStart.test(command)) return false;
  if (/(^|\s)(-[A-Za-z]*F[A-Za-z]*|--fixed-strings)(\s|$)/.test(command)) return false;
  const alternation =
    command.includes("\\|") || /'[^']*\|[^']*'|"[^"]*\|[^"]*"/.test(command) || /(^|\s)-e\s.*\s-e\s/.test(command);
  if (!alternation) return false;
  const zone = standardZonePattern();
  if (!zone) return false;
  return !zone.test(cwd ? command.replaceAll(`${cwd}/`, "") : command);
}

/**
 * Whether search-drift.sh may deny this same shell call as a concept search: it runs beside this
 * hook on the same PreToolUse and its deny is the steering that call gets, so the nudge stays out
 * of it. Reads are never denied (bd tea-rags-mcp-nxg76), so only a command that is both a ledger
 * read and a concept search can collide. Reads search-drift's per-session state
 * ("<searches> 0 0 <last deny epoch>") either before its update — this call would be search 3,
 * cooldown over — or after it: a deny just written. Errs toward silence: a counter already bumped
 * by this call can only suppress a nudge, never let one through beside a deny.
 */
function driftSearchDenyMayFire(stateDir, harness, sid, command, cwd) {
  const file = join(stateDir, `drift-${harness}-${sid}`);
  let state;
  let writtenMs;
  try {
    state = readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
    writtenMs = statSync(file).mtimeMs;
  } catch {
    state = [0, 0, 0, 0];
    writtenMs = 0;
  }
  const [searches, , , lastDeny] = state;
  if (state.length < 4 || state.some((n) => !Number.isInteger(n))) return false;
  const now = Number.parseInt(process.env.TEA_RAGS_HOOK_NOW ?? "", 10) || Math.floor(Date.now() / 1000);
  if (lastDeny > 0 && now - lastDeny < DRIFT_JUST_DENIED_SEC) return true;
  // Written after this process started: search-drift already counted this call and allowed it.
  if (writtenMs >= Date.now() - process.uptime() * 1000) return false;
  if (typeof command !== "string" || !conceptShellSearch(command, cwd)) return false;
  return searches + 1 >= DRIFT_SEARCH_STREAK && now - lastDeny >= DRIFT_COOLDOWN_SEC;
}

/** The zone pattern search-drift.sh reads (standard-zone.ere beside this script) as a RegExp; null when absent. */
function standardZonePattern() {
  try {
    const ere = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "standard-zone.ere"), "utf8").trim();
    return ere ? new RegExp(ere.replaceAll("[:space:]", "\\s")) : null;
  } catch {
    return null;
  }
}

/**
 * Stdout of `tea-rags <args>`, or null when no binary runs. A non-zero exit still answers with
 * what it printed (`project indexed` exits 1 for "not indexed"). `TEA_RAGS_BIN` set → that
 * binary only, as in search-drift.sh.
 */
function teaRagsOutput(args, timeoutMs) {
  const home = process.env.HOME ?? "";
  const bins = process.env.TEA_RAGS_BIN
    ? [process.env.TEA_RAGS_BIN]
    : ["tea-rags", `${home}/.npm-global/bin/tea-rags`, "/opt/homebrew/bin/tea-rags", "/usr/local/bin/tea-rags"];
  for (const bin of bins) {
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES") continue;
      return typeof error?.stdout === "string" ? error.stdout : "";
    }
  }
  return null;
}

/**
 * The index answer for raw-read targets, through `tea-rags project indexed` (the membership
 * test search-drift.sh runs): `{ status: "indexed", relativePath }` for the first indexed
 * path, `{ status: "absent" }` when none is, `{ status: "unknown" }` when the CLI is missing,
 * slow or unparsable.
 */
export function cliIndexedLookup(paths) {
  const args = ["project", "indexed", ...paths.flatMap((path) => ["--path", path]), "--json"];
  const out = teaRagsOutput(args, INDEXED_LOOKUP_TIMEOUT_MS);
  if (out === null) return { status: "unknown" };
  try {
    const answer = JSON.parse(out);
    if (answer?.indexed === true && typeof answer.relativePath === "string") {
      return { status: "indexed", relativePath: answer.relativePath };
    }
    return answer?.indexed === false ? { status: "absent" } : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * The outlines of up to MAX_OUTLINE_FILES indexed files in ONE
 * `tea-rags call find_symbol {path, symbols: [<relativePath>…], metaOnly: true}` (metaOnly →
 * an outline even for a small file): Map relativePath → outline text, a file the index does
 * not hold mapped to "". Null when the CLI is missing, slow or unparsable.
 */
export function cliOutlines(relativePaths, cwd) {
  const request = JSON.stringify({ path: cwd, symbols: relativePaths, metaOnly: true });
  const out = teaRagsOutput(["call", "find_symbol", request, "--format", "json"], OUTLINE_LOOKUP_TIMEOUT_MS);
  let rows;
  try {
    rows = JSON.parse(out ?? "").results;
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const outlines = new Map(relativePaths.map((rel) => [rel, ""]));
  for (const row of rows) {
    const rel = row?.payload?.request ?? row?.payload?.relativePath;
    if (outlines.has(rel) && typeof row.payload.content === "string") outlines.set(rel, row.payload.content);
  }
  return outlines;
}

/**
 * Line-ranged entries of a file outline: a member line ends in ` L<start>-<end>` after an
 * optional ` (visibility)` → `{ id, start, end }`; a `header A–B` line → `{ id: <the ranged
 * entry enclosing it>, start, end, header: true }`. Declaration-only ids carry no range and
 * yield no entry, so an outline without ranges yields none.
 */
function outlineEntries(text) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    const header = /^\s+header (\d+)[–-](\d+)(?::.*)?$/.exec(line);
    if (header) {
      const [start, end] = [Number(header[1]), Number(header[2])];
      const owner = entries.findLast((e) => !e.header && e.start <= start && e.end >= end);
      if (owner) entries.push({ id: owner.id, start, end, header: true });
      continue;
    }
    const member = /^\s+(\S.*?)(?: \([a-z_ ]+\))? L(\d+)-(\d+)$/.exec(line);
    if (member) entries.push({ id: member[1], start: Number(member[2]), end: Number(member[3]) });
  }
  return entries;
}

/**
 * The outline ids covering lines `[a, b]`: `ids` = the innermost members overlapping them;
 * `owners` = containers whose own (header) code the lines touch — a header entry, or a
 * container no member of which overlaps. Lines no entry covers name nothing.
 */
function coveringOutlineIds(entries, a, b) {
  const members = entries.filter((e) => !e.header);
  const inside = (o, m) => o !== m && o.start >= m.start && o.end <= m.end && (o.start > m.start || o.end < m.end);
  const isContainer = (m) => members.some((o) => inside(o, m));
  const overlapping = members.filter((m) => m.start <= b && m.end >= a);
  const leaves = overlapping.filter((m) => !overlapping.some((o) => inside(o, m)));
  const headers = entries.filter((e) => e.header && e.start <= b && e.end >= a).map((e) => e.id);
  return {
    ids: [...new Set(leaves.filter((m) => !isContainer(m)).map((m) => m.id))],
    owners: [...new Set([...headers, ...leaves.filter(isContainer).map((m) => m.id)])],
  };
}

/** Outline entries of indexed files `[{ path, relativePath }]`: per-session cache, ONE CLI call for the rest. */
function outlinesOf(ledger, files, cwd, lookup) {
  const outlines = new Map();
  const missing = [];
  for (const file of files) {
    const cached = ledger.outline(file.path);
    if (cached) outlines.set(file.path, cached);
    else missing.push(file);
  }
  if (!missing.length) return outlines;
  const answer = lookup(
    missing.map((f) => f.relativePath),
    cwd,
  );
  if (!answer) return outlines;
  for (const file of missing) {
    const entries = outlineEntries(answer.get(file.relativePath) ?? "");
    ledger.recordOutline(file.path, entries);
    outlines.set(file.path, entries);
  }
  return outlines;
}

/** The indexed source file a raw read targets, `{ path, relativePath }`, or null — see indexedSourceNudge. */
function indexedSourceHit(ledger, paths, cwd, lookup) {
  const zone = paths.length ? standardZonePattern() : null;
  if (!zone) return null;
  const turn = ledger.safeTurn();
  const shown = (path) => (cwd && !relative(cwd, path).startsWith("..") ? relative(cwd, path) : path);
  const known = [];
  const unknown = [];
  for (const path of new Set(paths)) {
    if (zone.test(shown(path))) continue;
    const seen = ledger.nudgeEntry(path);
    if (seen?.indexed === false || seen?.turn === turn) continue;
    (seen?.relativePath ? known : unknown).push(seen ?? { path });
  }
  let hit = known[0] ?? null;
  if (!hit && unknown.length) {
    const answer = lookup(unknown.map((u) => u.path));
    if (answer.status === "absent") unknown.forEach((u) => ledger.recordNudge(u.path, { indexed: false }));
    if (answer.status === "indexed") {
      const path = unknown.find(
        (u) => u.path === answer.relativePath || u.path.endsWith(`/${answer.relativePath}`),
      )?.path;
      if (path) hit = { path, relativePath: answer.relativePath };
    }
  }
  if (!hit) return null;
  ledger.recordNudge(hit.path, { relativePath: hit.relativePath, turn });
  return zone.test(hit.relativePath) ? null : { path: hit.path, relativePath: hit.relativePath };
}

/**
 * One line sending a raw read of an INDEXED SOURCE file to find_symbol(relativePath:). Never
 * for a zone path (config / DSL / routes / migrations / specs / data — core routes those to
 * the read tool), a file outside the index, or a file already nudged this turn; a file's index
 * verdict is looked up once per session (indexedSourceHit).
 */
function indexedSourceNudge(file) {
  return `tea-rags: ${file} is indexed source — find_symbol(relativePath: "${file}") returns it (full text ≤150 lines, else an outline to drill); several files → ONE find_symbol(symbols:[…])`;
}

/**
 * The read of `hit` covering < 80% of the file, named by the outline ids whose ` L<a>-<b>`
 * covers it: `find_symbol(symbols:[…])`, or `find_symbol(symbol:"<Class>")` for a range inside
 * a container's header only. Null — the generic nudge stands — when the outline has no range
 * for those lines, names more than MAX_NAMED_IDS ids, or cannot be fetched.
 */
function rangeNudge(ledger, hit, ranges, cwd, lineCount, outlineLookup) {
  const total = lineCount(hit.path);
  if (!total || !ranges.length) return null;
  const a = Math.min(...ranges.map((r) => r[0]));
  const b = Math.max(...ranges.map((r) => r[1]));
  if (b - a + 1 >= total * COVERAGE_THRESHOLD) return null;
  const entries = outlinesOf(ledger, [hit], cwd, outlineLookup).get(hit.path) ?? [];
  const { ids, owners } = coveringOutlineIds(entries, a, b);
  const span = a === b ? `line ${a}` : `lines ${a}–${b}`;
  if (!ids.length && owners.length === 1) {
    return `tea-rags: ${hit.relativePath} ${span} are the class-level header of ${owners[0]} — find_symbol(symbol:${JSON.stringify(owners[0])}) returns its header code + member ids; never Read offset/limit or a raw slice`;
  }
  const named = [...owners, ...ids];
  if (!named.length || named.length > MAX_NAMED_IDS) return null;
  return `tea-rags: ${hit.relativePath} ${span} sit in ${named.join(", ")} — find_symbol(symbols:${JSON.stringify(named)}) returns them whole; never Read offset/limit or a raw slice`;
}

/** Whether a shell command runs a line-numbered grep / rg (`-n`, `--line-number`). */
function numberedSearch(command) {
  return shellPipelines(command).some((pipeline) =>
    pipeline.some((stage) => {
      const words = commandWords(stage);
      const name = words.length ? baseName(words[0].word) : "";
      if (name !== "grep" && name !== "egrep" && name !== "rg") return false;
      return words.slice(1).some((w) => /^-[A-Za-z]*n[A-Za-z]*$/.test(w.word) || w.word === "--line-number");
    }),
  );
}

/**
 * PostToolUse: the hits of a Grep content search / a numbered shell grep in indexed source
 * (never a zone or test path) → ONE line naming their enclosing outline ids as a literal
 * `find_symbol(symbols:[…])`, the top MAX_OUTLINE_FILES files by hit count in one outline call.
 * Null when no hit sits inside a ranged outline entry, or every named id is already held.
 */
function grepHitNote(ledger, tool, input, response, cwd, outlineLookup) {
  const isFile = (path) => fileStamp(path) !== null;
  let printed;
  if (tool === "Grep") {
    if (input.output_mode !== "content" || input["-n"] === false) return null;
    const text = typeof response?.content === "string" ? response.content : "";
    const base = typeof input.path === "string" ? resolve(cwd, input.path) : cwd;
    printed = text ? printedNumberedLines(text, [base, cwd], isFile(base) ? base : null, isFile) : [];
  } else {
    if (typeof input.command !== "string" || !numberedSearch(input.command) || failedResponse(response)) return null;
    const stdout = response && typeof response === "object" ? (response.stdout ?? response.output) : null;
    printed = typeof stdout === "string" ? numberedGrepLines(input.command, stdout, cwd, isFile) : [];
  }
  const zone = printed.length ? standardZonePattern() : null;
  if (!zone) return null;
  const files = printed
    .map((p) => ({ ...p, relativePath: relative(cwd, p.path) }))
    .filter((p) => !p.relativePath.startsWith("..") && !isAbsolute(p.relativePath) && !zone.test(p.relativePath))
    .map((p) => ({ ...p, hits: p.ranges.reduce((n, [s, e]) => n + e - s + 1, 0) }))
    .sort((x, y) => y.hits - x.hits)
    .slice(0, MAX_OUTLINE_FILES);
  if (!files.length) return null;
  const outlines = outlinesOf(ledger, files, cwd, outlineLookup);
  const parts = [];
  const named = [];
  for (const file of files) {
    const entries = outlines.get(file.path) ?? [];
    const ids = [];
    for (const [s, e] of file.ranges) {
      for (let n = s; n <= Math.min(e, s + MAX_NUMBERED_LINES); n++) {
        const { ids: leaves, owners } = coveringOutlineIds(entries, n, n);
        ids.push(...owners, ...leaves);
      }
    }
    const fresh = [...new Set(ids)].filter((id) => !named.includes(id) && !ledger.symbol(id));
    const kept = fresh.slice(0, MAX_NAMED_IDS - named.length);
    if (!kept.length) continue;
    named.push(...kept);
    parts.push(`${file.relativePath}: ${kept.join(", ")}`);
  }
  if (!named.length) return null;
  return `tea-rags: the hits sit in ${parts.join("; ")} — find_symbol(symbols:${JSON.stringify(named)}) returns those bodies whole; never a Read slice`;
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
    // Record returned content only, never the requested range or the current file's size alone.
    const file = response?.file;
    if (
      failedResponse(response) ||
      !file ||
      typeof file.content !== "string" ||
      !Number.isInteger(file.startLine) ||
      file.startLine < 1 ||
      !Number.isInteger(file.numLines) ||
      file.numLines < 1
    ) {
      return;
    }
    const count = Math.min(file.numLines, countLines(file.content));
    ledger.record(abs, deliveredRanges(abs, [[file.startLine, file.startLine + count - 1]], file.content), "Read");
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
    if (failedResponse(response)) return;
    const stdout = response && typeof response === "object" ? (response.stdout ?? response.output) : null;
    if (typeof stdout !== "string" || !stdout) return;
    const printed = [
      ...bashReads(input.command, cwd, lineCount).map((read) => ({
        ...read,
        ranges: deliveredRanges(read.path, read.ranges, stdout),
      })),
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
    const ranges =
      row.kind === "containerHeader"
        ? deliveredHeaderRanges(path, row)
        : deliveredRanges(path, [[row.startLine, row.endLine]], row.content);
    ledger.record(path, ranges, teaRags);
    const whole = ranges.length === 1 && ranges[0][0] === row.startLine && ranges[0][1] === row.endLine;
    if (whole && row.kind !== "containerHeader" && typeof row.symbolId === "string" && row.symbolId) {
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
  const flag = process.argv.indexOf("--harness");
  const harness = flag >= 0 && HARNESSES.has(process.argv[flag + 1]) ? process.argv[flag + 1] : "claude";
  const stateDir =
    process.env.TEA_RAGS_HOOK_STATE_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    process.env.PLUGIN_DATA ||
    join(process.env.TMPDIR || "/tmp", "tea-rags-hooks");
  let input = null;
  let out;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    out = handleHookEvent(input, { stateDir, harness });
  } catch {
    // fail open: the tool call proceeds untouched (Cursor still gets a pass-through JSON)
    out = harnessAnswer(harness, String(input?.hook_event_name ?? "pretooluse").toLowerCase(), []);
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
