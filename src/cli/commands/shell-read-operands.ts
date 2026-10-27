/**
 * The files a Bash command reads through a file reader — `cat`, `sed`, `head`,
 * `tail`, `less`, `more` — resolved against the command's cwd (bd
 * tea-rags-mcp-ueplg). The plugin's PreToolUse(Bash) hook checks them against
 * the index, so a parse it is unsure of must never deny: `null` = cannot read
 * the command confidently (command substitution, heredoc, process
 * substitution, unbalanced quotes), and an operand it cannot resolve
 * (variable, glob, `~`, `-`) is skipped. Pure: no I/O.
 */

import { resolve } from "node:path";

/** A shell word, or a control operator / redirection the tokenizer split out. */
type ShellToken = ShellWord | { kind: "op"; text: string };
/** `dynamic` = holds a variable, glob or `~`: its file is unknown until the shell expands it. */
interface ShellWord {
  kind: "word";
  text: string;
  dynamic: boolean;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "|&"]);
const READERS = new Set(["cat", "sed", "head", "tail", "less", "more"]);
/** Options whose value is the next word, per reader. */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  sed: new Set(["-e", "-f", "-l"]),
};

/** Splits `command` into words and operators; null when the command is not plain enough to trust. */
function tokenize(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let word = "";
  let inWord = false;
  let dynamic = false;
  const flush = (): void => {
    if (inWord) tokens.push({ kind: "word", text: word, dynamic });
    word = "";
    inWord = false;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1] ?? "";
    if (ch === "`" || (ch === "$" && next === "(")) return null;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "`" || (command[j] === "$" && command[j + 1] === "(")) return null;
        if (command[j] === "$") dynamic = true;
        if (command[j] === "\\" && j + 1 < command.length) j++;
        word += command[j];
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
    } else if (ch === "\\") {
      word += next;
      inWord = true;
      i++;
    } else if (ch === " " || ch === "\t") {
      flush();
    } else if (ch === "<") {
      if (next === "<" || next === "(") return null;
      flush();
      if (next === "&") {
        tokens.push({ kind: "op", text: "<&" });
        i++;
      } else tokens.push({ kind: "op", text: "<" });
    } else if (ch === ">" || (ch === "&" && next === ">")) {
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flush();
      let op = ch === "&" ? "&>" : ">";
      i += ch === "&" ? 1 : 0;
      if (command[i + 1] === ">") {
        op += ">";
        i++;
      }
      if (command[i + 1] === "&") {
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
        op = ">&";
      }
      tokens.push({ kind: "op", text: op });
    } else if (ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "|" || ch === "&") {
      flush();
      const pair = ch + next;
      if (pair === "&&" || pair === "||" || pair === "|&") {
        tokens.push({ kind: "op", text: pair });
        i++;
      } else tokens.push({ kind: "op", text: ch });
    } else {
      if (ch === "$" || ch === "*" || ch === "?" || ch === "[" || (ch === "~" && !inWord)) dynamic = true;
      word += ch;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

/** One simple command: its words, plus the files its `<` redirects read. */
interface SimpleShellCommand {
  argv: ShellWord[];
  stdin: ShellWord[];
}

const FILE_REDIRECTS = new Set(["<", ">", ">>", "&>"]);

/** Splits tokens into simple commands at control operators; redirect targets leave argv. */
function simpleCommands(tokens: ShellToken[]): SimpleShellCommand[] {
  const commands: SimpleShellCommand[] = [];
  let current: SimpleShellCommand = { argv: [], stdin: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "word") {
      current.argv.push(token);
    } else if (SEPARATORS.has(token.text)) {
      commands.push(current);
      current = { argv: [], stdin: [] };
    } else {
      const target = tokens[i + 1];
      if (FILE_REDIRECTS.has(token.text) && target?.kind === "word") {
        if (token.text === "<") current.stdin.push(target);
        i++;
      }
    }
  }
  commands.push(current);
  return commands;
}

/** The file operands of one reader invocation (`args` = words after the command name); null = not a read. */
function readerOperands(reader: string, args: ShellWord[]): ShellWord[] | null {
  const valueOptions = VALUE_OPTIONS[reader] ?? new Set<string>();
  const operands: ShellWord[] = [];
  let scriptGiven = reader !== "sed";
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const { text } = arg;
    if (!optionsDone && text === "--") {
      optionsDone = true;
    } else if (!optionsDone && text.startsWith("-") && text.length > 1 && !arg.dynamic) {
      if (reader === "sed") {
        if (text === "--in-place" || (!text.startsWith("--") && text.includes("i"))) return null;
        if (text.startsWith("--expression") || text.startsWith("--file")) {
          scriptGiven = true;
          if (!text.includes("=")) i++;
          continue;
        }
        const valueAt = text.search(/[efl]/);
        if (valueAt > 0 && !text.startsWith("--")) {
          if (text[valueAt] !== "l") scriptGiven = true;
          if (valueAt === text.length - 1) i++;
          continue;
        }
      }
      if (valueOptions.has(text)) i++;
    } else if (!scriptGiven) {
      scriptGiven = true;
    } else {
      operands.push(arg);
    }
  }
  return operands;
}

/**
 * The absolute paths `command` reads through a file reader, in command order,
 * or null when the command cannot be read confidently.
 */
export function shellReadOperands(command: string, cwd: string): string[] | null {
  const tokens = tokenize(command);
  if (!tokens) return null;
  let dir = cwd;
  const paths: string[] = [];
  for (const { argv: words, stdin } of simpleCommands(tokens)) {
    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text)) start++;
    const name = words[start];
    if (!name) continue;
    if (name.text === "cd") {
      const target = words[start + 1];
      if (target && !target.dynamic) dir = resolve(dir, target.text);
      continue;
    }
    const reader = name.text.split("/").pop() ?? "";
    if (!READERS.has(reader)) continue;
    const operands = readerOperands(reader, words.slice(start + 1));
    if (!operands) continue;
    for (const operand of [...operands, ...stdin]) {
      if (operand.dynamic || operand.text === "-" || operand.text === "") continue;
      paths.push(resolve(dir, operand.text));
    }
  }
  return paths;
}
