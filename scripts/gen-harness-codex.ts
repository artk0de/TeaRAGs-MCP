import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hookContext, renderDinopowersSkills, ROUTING_HOOKS, wrapperNames } from "./harness/dinopowers.js";
import {
  DINOPOWERS_NAME,
  DINOPOWERS_SRC,
  formatPackage,
  formatRootFile,
  HARNESS_PACKAGES,
  internalDescription,
  json,
  linkedPluginFiles,
  PLUGIN_NAME,
  PLUGIN_SRC,
  readManifest,
  readSkills,
  selectSkills,
  SHARED_HOOK_SCRIPTS,
  TURN_ROUTING_SOURCE,
  walk,
  writePackage,
  writeRootFile,
} from "./harness/package.js";
import {
  extractInjectionBlock,
  parseFrontmatter,
  renderFrontmatter,
  toHarnessSkill,
  toHarnessText,
  type HarnessDialect,
  type SkillOptions,
} from "./harness/transform.js";

/** Package root, relative to the repository root. */
export const CODEX_HARNESS_DIR = "harness/codex";
/**
 * Cap on each shipped skill description. Codex clips every description in its
 * skills list, mid-word and silently — measured ~467–470 chars with 55 skills
 * listed (codex-cli 0.162.1); the clip shrinks as the list grows.
 */
export const CODEX_DESCRIPTION_MAX_CHARS = 440;

/** Root marketplace manifest: the repository root is the Codex marketplace root. */
export const CODEX_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
const MARKETPLACE_NAME = "tea-rags";
const CORE_SKILL = "tea-rags-core";
const CORE_DESCRIPTION =
  "tea-rags core rules: code search, navigation and project data through the tea-rags MCP tools and resources. Load before any code search, navigation or code change in an indexed repository.";

/** Codex hands plugin hook commands the plugin directory as `PLUGIN_ROOT`. */
const PLUGIN_ROOT_VAR = `\${PLUGIN_ROOT}`;

const CODEX_DIALECT: HarnessDialect = {
  skillMention: (name) => `$${name}`,
  listsQualifiedSkills: true,
  pluginRootVar: PLUGIN_ROOT_VAR,
  projectDirVar: "$PWD",
  readResourceTool: "read_mcp_resource",
  listResourcesTool: "list_mcp_resources",
  // bd tea-rags-mcp-onli7: rg ships inside Codex (`@openai/codex-<platform>/vendor/<triple>/codex-path/rg`,
  // on its shell PATH since codex-cli 0.162.1). `grep -rl` ignores .gitignore: a whole-repo run walked
  // node_modules/build/.git and never completed in the read-only sandbox (live D3 Q3, 2/3 runs).
  codeSearchTool: "shell rg -l --hidden --glob '!.git'",
  foldsSearchLiteral: true,
  // One file per command — `one-file-read.sh` (ONE_FILE_READ_SCRIPT) enforces it.
  codeReadTool: "shell sed -n '<start>,<end>p' <one file>",
};

/**
 * Codex lists skills by description only — the body never enters context until
 * the model opens the file, unlike Claude Code's Skill tool. Measured: plans
 * built from this core instead of the skill (Task 14 eval).
 * Leads with how to call a tea-rags tool: under code mode a model filtered `ALL_TOOLS` by "tea-rags",
 * got `[]` and answered "tools unavailable". Core has no room for it ({@link CODEX_CORE_HOOK_BUDGET}).
 */
const CODEX_SKILL_LOADING = `
**tea-rags tools** (named bare here: \`find_symbol\`, …) are MCP tools of server \`tea-rags\`. Code mode
(an \`exec\` tool that runs JS): call them inside \`exec\` as \`await tools.mcp__tea_rags__<tool>({...})\`,
list names with \`ALL_TOOLS.filter(t => t.name.includes("tea_rags")).map(t => t.name)\`
(\`"tea-rags"\` matches none). Read only the needed tool's description; never dump
the entire catalog with full descriptions.
Otherwise they are direct tools — call them as listed.

**Skills are not loaded for you** — except this core:
\`$tea-rags-core\` IS this text, never open its \`SKILL.md\`. A task a skill covers (\`$name\` /
\`$dino-<name>\`) → read its \`SKILL.md\` before using it, unless its instructions
are already in the current context. Reuse loaded skills, references and guides
across follow-ups; a new turn alone is not a reason to read them again.
Retained current text satisfies a workflow's read-before-use requirements.
Reopen only changed instructions or material missing after compaction.
Load only the selected workflow's needed references and handoffs, using the
listed skill paths rather than inventing paths or loading adjacent skills.
Every skill you name in a plan must be available in context; a plan from memory
is not reading it. \`repair/<family>.md\`, \`rules/…\` resolve from the plugin root
(the folder holding \`skills/\`), never the skill's own folder.

**Lag follow-ups.** Incremental \`index_codebase\` is a prelude, not the answer:
the next step still serves the user's request (search / \`$explore\` over the
code they asked about). Graph answer with \`changedFiles\` > 0 and no
\`codegraph\` floor → edges touching changed files are the index's: re-check
changed-file callers via \`find_symbol\`, find missing ones via ${CODEX_DIALECT.codeSearchTool}
(literal) — never a bare retry of the graph call.
`;

/**
 * Leads the core, right under its H1: a multi-file \`cat\` truncates from the
 * middle, so the rule against it must sit where truncation never reaches.
 * Codex T22 r6: one run cat'ed 11 files and lost SKILL.md, another read nothing;
 * r16: a `python3 -c` loop printed five skills at once — the ban names no tool.
 * The skill-path rule that used to follow it rides `codex-rules.txt` ({@link CODEX_SKILL_LOADING}):
 * naming the read tool as a one-file `sed -n` range grew core past {@link CODEX_CORE_HOOK_BUDGET}
 * (bd tea-rags-mcp-onli7), and the core hook's cap is measured.
 */
const CODEX_READ_DISCIPLINE = `**Read ONE file per command**, any tool alike (\`cat\`, \`sed\`, \`python3\`, a loop):
output past ~10k tokens loses its middle (\`…N tokens truncated…\`), and
a rule you did not see is not a rule you may guess. Missing instructions → read only
their missing ranges (\`sed -n\`). For source, follow the tea-rags continuation only
if needed code is missing; never reread retained bodies because output was truncated.
`;

/** Puts \`prelude\` right after the body's H1 (or first, when there is none). */
/**
 * Codex core's guide-read line names the call: on Codex a bare `list_mcp_resources` ({} args) lists
 * EVERY server — codex_apps alone was 44k of a 51k-char listing, tea-rags' own 3.7k (bd tea-rags-mcp-kk5xe).
 * The guide URI is known, so the line reads it directly on the tea-rags server.
 */
const CORE_GUIDE_READ_ANCHOR = /(\*\*Read `tea-rags:\/\/guide\/<topic>` when\*\*)\s+\(/;
const CODEX_GUIDE_READ_CALL =
  '`read_mcp_resource(server: "tea-rags", uri: "tea-rags://guide/<topic>")`, never a bare ' +
  '`list_mcp_resources` (list only with `server: "tea-rags"`)';

function withCodexGuideReads(core: string): string {
  if (!CORE_GUIDE_READ_ANCHOR.test(core)) throw new Error("core.md lost its guide-read line (kk5xe anchor)");
  return core.replace(CORE_GUIDE_READ_ANCHOR, (_match, head: string) => `${head} → ${CODEX_GUIDE_READ_CALL} (`);
}

function withCodexPrelude(body: string, prelude: string): string {
  const heading = /^# [^\n]*\n+/.exec(body);
  if (!heading) return `${prelude}\n${body}`;
  return `${heading[0]}${prelude}\n${body.slice(heading[0].length)}`;
}

/**
 * A Claude Code SKILL.md in Codex's dialect (see `toHarnessText` for the rewrite
 * list); a source `codex-description` replaces `description` — the short form
 * that survives {@link CODEX_DESCRIPTION_MAX_CHARS}.
 */
export function toCodexSkill(md: string, options: SkillOptions): string {
  const codexDescription = parseFrontmatter(md).fields["codex-description"];
  return toHarnessSkill(md, CODEX_DIALECT, {
    ...options,
    description: options.description ?? (codexDescription || undefined),
  });
}

const SUBAGENT_SCRIPT = `#!/bin/bash
# Codex SubagentStart hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Hands every subagent the tea-rags search block (scripts/subagent-block.txt) as
# hookSpecificOutput.additionalContext, prefixed with the repository's project
# alias when tea-rags resolves one. Nothing here fails the hook.

INPUT=$(cat)
ROOT="\${PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
BLOCK=$(cat "$ROOT/scripts/subagent-block.txt" 2>/dev/null)
if [ -z "$BLOCK" ]; then
  exit 0
fi

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
CWD="\${CWD:-$PWD}"
ALIAS=""
if command -v tea-rags >/dev/null 2>&1; then
  ALIAS=$(tea-rags project exist --path "$CWD" --repository --print-name 2>/dev/null | head -n 1)
fi
if [ -n "$ALIAS" ]; then
  BLOCK="tea-rags project alias for this repository: \\\`\${ALIAS}\\\` — pass project=\\"\${ALIAS}\\" together with path=<your working directory> on every tea-rags call.
\${BLOCK}"
fi

jq -n --arg context "$BLOCK" '{
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: $context
  }
}'
exit 0
`;

/** Codex tool names a shell command arrives under at PreToolUse. */
const SHELL_TOOL_MATCHER = "^(Bash|shell|exec_command)$";

/**
 * Codex tool names of the tea-rags MCP server's tools (`mcp__<server>__<tool>`) at PostToolUse. Both
 * spellings: a direct call keeps the server name, code mode exposes a nested tool as a normalized JS
 * identifier (`mcp__tea_rags__<tool>`; codex-cli 0.162.1). A code-mode session denied "3 reads … no
 * tea-rags call" one read after two find_symbol / get_naming_lexicon scripts: the reset never matched.
 */
const TEA_RAGS_MCP_TOOL_MATCHER = "^mcp__.*tea[-_]rags.*__";

/** The shared reread ledger (Node script) — read steering: re-read note + indexed-source nudge. */
const LEDGER_COMMAND = `node "${PLUGIN_ROOT_VAR}/scripts/reread-ledger.mjs"`;

/**
 * Codex PreToolUse hook: exit 2 (reason on stderr) for a shell command that
 * prints two or more distinct `.md` files. Codex T22 eval: a SKILL.md read only
 * inside a multi-file `cat a && cat b` / `python3 -c` loop lost its output
 * contract in 5/5 rounds. Readers are counted per shell segment; listings and
 * searches (`ls`, `rg`, `grep`, `find`) never count. Anything it cannot parse
 * is allowed.
 */
const ONE_FILE_READ_SCRIPT = String.raw`#!/bin/bash
# Codex PreToolUse hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Rejects (exit 2, reason on stderr) a shell command that prints more than one
# Markdown file: output past ~10k tokens loses its middle, and a skill read inside
# a multi-file batch loses its output contract. Single-file reads, sed ranges,
# listings and searches pass; anything unparseable passes.

INPUT=$(cat)
command -v python3 >/dev/null 2>&1 || exit 0
TEA_RAGS_HOOK_INPUT="$INPUT" exec python3 -I - <<'PY'
import json, os, re, shlex, sys

READERS = {"cat", "head", "tail", "less", "more", "bat", "batcat", "nl", "tac", "awk", "sed"}
INTERPRETERS = {"python", "python3", "node", "ruby", "perl", "deno", "bun"}
SHELLS = {"bash", "sh", "zsh", "dash"}
PREFIXES = {"sudo", "command", "env", "time", "nohup", "exec", "xargs", "do", "then", "else", "{", "(", "!"}
SEPARATORS = {"&&", "||", ";", "|", "&", "\n", "(", ")", ";;", "|&"}
READ_CALL = re.compile(r"read_text|read_bytes|\.read\(|open\(|readFileSync|readFile\(|File\.read|readlines|\bcat\b")
MD_LITERAL = re.compile(r"""["']([^"'\s]*\.md)["']""", re.I)
MD_TOKEN = re.compile(r"\.md$", re.I)
GLOB = re.compile(r"[*?\[]")


def tokens(command):
    lex = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    return list(lex)


def segments(command):
    current = []
    for token in tokens(command):
        if token in SEPARATORS:
            if current:
                yield current
            current = []
        else:
            current.append(token)
    if current:
        yield current


def md_paths(args):
    found, skip = set(), False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in (">", ">>"):
            skip = True
            continue
        if arg.startswith("-") or not MD_TOKEN.search(arg):
            continue
        found.update({arg + "#1", arg + "#2"} if GLOB.search(arg) else {arg})
    return found


def inline_code(args):
    for flag in ("-c", "-e", "--eval"):
        if flag in args[:-1]:
            return args[args.index(flag) + 1]
    return None


def shell_code(args):
    """The script of sh -c / bash -lc, or None."""
    for i, arg in enumerate(args[:-1]):
        if re.match(r"^-[a-z]*c$", arg):
            return args[i + 1]
    return None


HEREDOC = re.compile(r"""^([^\n]*?)<<-?[ \t]*(['"]?)(\w+)\2([^\n]*)\n(.*?)\n[ \t]*\3[ \t]*(?=\n|$)""", re.S | re.M)


def code_md(code):
    """Quoted .md literals of inline interpreter code that reads files; globs count as two."""
    found = set()
    if READ_CALL.search(code):
        for path in MD_LITERAL.findall(code):
            found.update({path + "#1", path + "#2"} if GLOB.search(path) else {path})
    return found


def heredocs(command):
    """The command without heredoc bodies, and the .md paths an interpreter heredoc reads."""
    found = set()

    def strip(match):
        prefix, rest, body = match.group(1), match.group(4), match.group(5)
        words = list(segments(prefix))
        words = words[-1] if words else []
        while words and (words[0] in PREFIXES or re.match(r"^\w+=", words[0])):
            words = words[1:]
        if words and os.path.basename(words[0]) in INTERPRETERS:
            found.update(code_md(body))
        return prefix + rest

    return HEREDOC.sub(strip, command), found


def reads(command, depth=0):
    """Distinct .md paths the command prints; globs count as two."""
    command, found = heredocs(command)
    loop_words, reader_on_variable = set(), False
    for words in segments(command):
        while words and (words[0] in PREFIXES or re.match(r"^\w+=", words[0])):
            words = words[1:]
        if not words:
            continue
        name, args = os.path.basename(words[0]), words[1:]
        if name == "for" and "in" in args:
            loop_words.update(md_paths(args[args.index("in") + 1:]))
        elif name in SHELLS and depth < 3:
            code = shell_code(args)
            if code is not None:
                found |= reads(code, depth + 1)
        elif name in INTERPRETERS:
            code = inline_code(args)
            if code is not None:
                found |= code_md(code)
        elif name in READERS:
            if name == "sed" and any(re.match(r"^-[a-zA-Z]*i", a) or a.startswith("--in-place") for a in args):
                continue
            paths = md_paths(args)
            found |= paths
            if not paths and any("$" in a for a in args):
                reader_on_variable = True
    if reader_on_variable:
        found |= loop_words
    return found


try:
    data = json.loads(os.environ.get("TEA_RAGS_HOOK_INPUT", ""))
    command = (data.get("tool_input") or {}).get("command")
    if isinstance(command, list):
        argv = [str(a) for a in command]
        code = shell_code(argv[1:]) if argv and os.path.basename(argv[0]) in SHELLS else None
        command = code if code is not None else shlex.join(argv)
    if not isinstance(command, str):
        sys.exit(0)
    count = len(reads(command))
except SystemExit:
    raise
except Exception:
    sys.exit(0)

if count >= 2:
    sys.stderr.write(
        "tea-rags: read ONE file per command — this command prints %d .md files and output past "
        "~10k tokens loses its middle. Re-run with one file per command (sed -n ranges for long files; an indexed file → find_symbol(relativePath:) instead).\n" % count
    )
    sys.exit(2)
sys.exit(0)
PY
`;

/**
 * Cap on one hook's `additionalContext`, in chars. Codex keeps ~2.5k tokens of a hook's output and
 * drops the middle past that; at ~3.9 chars/token that is ~9.8k chars, so 9,500 leaves room for
 * token-dense digest tables. The cap is per hook: a 2026-10-27 `codex exec` probe with two
 * SessionStart hooks of 7,057 and 5,897 chars showed both blocks whole in both runs, so core and the
 * prime digest ride separate hooks, each with the whole budget. Three SessionStart hooks now: core,
 * the Codex-only rules, then the digest.
 */
export const CODEX_HOOK_CONTEXT_BUDGET = 9_500;

/**
 * Cap on one PROSE hook's payload (core, and the Codex-only rules hook), in chars — prose, not the digest's token-dense tables. A
 * 2026-10-27 probe (one SessionStart hook of ~58-char prose lines, 2 runs per size) delivered 9,686
 * chars whole and cut 10,150 (`…80 tokens truncated…`); 9,650 stays under the measured whole size.
 */
export const CODEX_CORE_HOOK_BUDGET = 9_650;

/**
 * Fits the prime digest into {@link CODEX_HOOK_CONTEXT_BUDGET} minus the chars already used: sections in
 * routing priority (Project, Status, Drift, Enrichment, Language capability, Codegraph resolve, the
 * rest in digest order, signal-threshold tables last), long lines clipped, and a pointer to the full
 * digest when a section is cut.
 * argv: budget, chars already used in the same hook (0 for the digest hook). stdin: the digest.
 */
const FIT_DIGEST_SCRIPT = String.raw`# Generated by scripts/gen-harness-codex.ts, do not edit.
import re, sys

budget, used = int(sys.argv[1]), int(sys.argv[2])
digest = sys.stdin.read().strip()
if not digest:
    sys.exit(0)
lines = digest.split("\n")
head = lines[0] if lines[0].startswith("# ") else ""
body = "\n".join(lines[1:] if head else lines)
sections = [s.strip("\n") for s in re.split(r"\n(?=## )", "\n" + body) if s.strip()]
ORDER = ["## Project", "## Status", "## Drift", "## Enrichment", "## Language capability", "## Codegraph resolve"]


def rank(section):
    return next((i for i, prefix in enumerate(ORDER) if section.startswith(prefix)), len(ORDER))


def clip(section):
    return "\n".join(line if len(line) <= 240 else line[:239] + "…" for line in section.split("\n"))


tick = chr(96)
match = re.search("^name: " + tick + "([^" + tick + "]+)" + tick, digest, re.M)
alias = match.group(1) if match else "<alias>"
pointer = "Digest cut to the hook budget; full digest: tea-rags resource tea-rags://project/" + alias + "/digest"
room = budget - used - 2 - len(pointer) - 2
kept = [head] if head and len(head) + 2 <= room else []
size = sum(len(part) + 2 for part in kept)
cut = False
for section in sorted(sections, key=rank):
    section = clip(section)
    if size + len(section) + 2 <= room:
        kept.append(section)
        size += len(section) + 2
    else:
        cut = True
print("\n\n".join(kept + ([pointer] if cut else [])))
`;

/**
 * Codex SessionStart hook handing one prose payload (`scripts/<file>`) to the main session as
 * `additionalContext`. Core arrives without the CLI; plugins cannot ship AGENTS.md, so these hooks put
 * core into every session: `core.txt` (prelude + core rules) first, then `codex-rules.txt` (the
 * Codex-only rules) in its own hook — the cap is per hook ({@link CODEX_CORE_HOOK_BUDGET} each), so
 * splitting keeps both whole. Both run before {@link SESSION_DIGEST_SCRIPT}.
 */
const proseHookScript = (file: string): string => `#!/bin/bash
# Codex SessionStart hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Hands scripts/${file} to the main session as hookSpecificOutput.additionalContext.
# The prime digest rides its own hook (session-digest.sh). Nothing here fails the hook.

cat > /dev/null
ROOT="\${PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONTEXT=$(cat "$ROOT/scripts/${file}" 2>/dev/null)
if [ -z "$CONTEXT" ]; then
  exit 0
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
exit 0
`;

/**
 * Codex SessionStart hook for tea-rags: the prime digest of the session's project, fitted to the
 * whole {@link CODEX_HOOK_CONTEXT_BUDGET} by `scripts/fit-digest.py` so Codex never truncates it out
 * of the middle. A missing CLI or python3, or an empty digest, emits nothing.
 */
const SESSION_DIGEST_SCRIPT = `#!/bin/bash
# Codex SessionStart hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Hands \`tea-rags prime --agent "$PWD"\` to the main session as hookSpecificOutput.additionalContext.
# A missing CLI or digest emits nothing. Nothing here fails the hook.

cat > /dev/null
ROOT="\${PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
if ! command -v tea-rags > /dev/null 2>&1 || ! command -v python3 > /dev/null 2>&1; then
  exit 0
fi
DIGEST=$(tea-rags prime --agent "$PWD" 2>/dev/null | python3 -I "$ROOT/scripts/fit-digest.py" ${CODEX_HOOK_CONTEXT_BUDGET} 0 2>/dev/null)
if [ -z "$DIGEST" ]; then
  exit 0
fi

jq -n --arg context "$DIGEST" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
exit 0
`;

/** Codex hook answering `event` with a dinopowers routing table from `scripts/<textFile>`. */
function routingScript(event: string, textFile: string): string {
  return `#!/bin/bash
# Codex ${event} hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Hands the dinopowers wrapper routing table (scripts/${textFile}) to the
# ${event === "SessionStart" ? "main session" : "subagent"} as hookSpecificOutput.additionalContext. Nothing here fails the hook.

cat > /dev/null
ROOT="\${PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONTEXT=$(cat "$ROOT/scripts/${textFile}" 2>/dev/null)
if [ -z "$CONTEXT" ]; then
  exit 0
fi

# The skills list is cut to a char budget, so a routed skill may be absent from it:
# name the installed SKILL.md of every \\$mention. tea-rags sits beside dinopowers —
# <marketplace>/tea-rags/<version> in the plugin cache, ../tea-rags in the repo.
TEA_RAGS=$(ls -d "$ROOT"/../../tea-rags/*/ 2>/dev/null | sort -V | tail -1)
[ -n "$TEA_RAGS" ] || TEA_RAGS="$ROOT/../tea-rags/"
TEA_RAGS=$(cd "$TEA_RAGS" 2>/dev/null && pwd)
FILES=""
for skill in $(printf '%s' "$CONTEXT" | grep -oE '\\$[a-z][a-z-]*' | sort -u | cut -c2-); do
  for dir in "$ROOT" "$TEA_RAGS"; do
    if [ -n "$dir" ] && [ -f "$dir/skills/$skill/SKILL.md" ]; then
      FILES="$FILES
\\$$skill → $dir/skills/$skill/SKILL.md"
      break
    fi
  done
done
if [ -n "$FILES" ]; then
  CONTEXT="$CONTEXT

Skill files — read the routed skill from this path; absent from the skills list ≠ not installed:$FILES"
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "${event}",
    additionalContext: $context
  }
}'
exit 0
`;
}

interface ShippedSkill {
  name: string;
  description: string;
}

function listChars(skills: ShippedSkill[]): number {
  return skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length, 0);
}

function skillRows(skills: ShippedSkill[]): string {
  return skills
    .map(
      (skill) =>
        `| \`${skill.name}\` | ${skill.description.length} | ${skill.name.length + skill.description.length} |`,
    )
    .join("\n");
}

function readme(version: string, skills: ShippedSkill[], hasCore: boolean, dinopowers: DinopowersPackage): string {
  const total = listChars(skills);
  const dinoTotal = listChars(dinopowers.skills);
  const core = hasCore
    ? "- `tea-rags/skills/tea-rags-core/` — `rules/core.md` as an always-relevant skill; every session gets it from the SessionStart hook; `AGENTS.tea-rags.md` — the same text, optional for your `AGENTS.md` (plugins cannot ship AGENTS.md)."
    : "- `rules/core.md` does not exist yet: no `tea-rags-core` skill and no `AGENTS.tea-rags.md` are emitted. They appear on the first `npm run gen:harness-codex` after it lands.";
  return `# tea-rags and dinopowers for Codex CLI

GENERATED by \`scripts/gen-harness-codex.ts\` from \`plugins/tea-rags/\` and \`plugins/dinopowers/\` — do not edit.
tea-rags ${version}, dinopowers ${dinopowers.version}.

Rendered from \`plugins/**/skills/**\`, \`plugins/tea-rags/rules/core.md\`,
\`rules/references/subagent-injection.md\` and the plugin version. Try an edit locally with
\`npm run gen:plugins\`; the release regenerates this package and commits it.

## Layout

- \`<repo>/${CODEX_MARKETPLACE_PATH}\` — marketplace \`${MARKETPLACE_NAME}\`; the repository root is its root,
  \`source.path\` = \`./${CODEX_HARNESS_DIR}/<plugin>\`.
- \`tea-rags/.codex-plugin/plugin.json\` — manifest: \`skills\`, \`mcpServers\`, \`hooks\` paths.
- \`tea-rags/.mcp.json\` — stdio server \`tea-rags server\`, tool calls pre-approved.
- \`tea-rags/hooks/hooks.json\` — SessionStart, three hooks in order: \`\${PLUGIN_ROOT}/scripts/session-start.sh\`
  (core rules, \`scripts/core.txt\`), \`\${PLUGIN_ROOT}/scripts/session-codex-rules.sh\` (Codex-only rules,
  \`scripts/codex-rules.txt\`), then \`\${PLUGIN_ROOT}/scripts/session-digest.sh\` (\`tea-rags prime "$PWD"\`
  fitted by \`scripts/fit-digest.py\`), each its own \`hookSpecificOutput.additionalContext\` (core and Codex rules
  ≤ ${CODEX_CORE_HOOK_BUDGET} each, digest ≤ ${CODEX_HOOK_CONTEXT_BUDGET} chars);
  SubagentStart \`\${PLUGIN_ROOT}/scripts/subagent-block.sh\` (\`hookSpecificOutput.additionalContext\`).
  PreToolUse (\`${SHELL_TOOL_MATCHER}\`) \`\${PLUGIN_ROOT}/scripts/one-file-read.sh\` — exit 2 for a shell command that prints
  two or more \`.md\` files (one file per command keeps a skill's output contract in view); then
  \`\${PLUGIN_ROOT}/scripts/search-drift.sh --harness codex\` — exit 2 once after 3 concept-shaped text searches
  (an alternation) with no tea-rags call (one deny per 120 s); literal searches and config / spec / migration paths
  are neutral; reset by PostToolUse (\`${TEA_RAGS_MCP_TOOL_MATCHER}\`). Reads are never denied (bd
  tea-rags-mcp-nxg76); then \`node \${PLUGIN_ROOT}/scripts/reread-ledger.mjs --harness codex\` — read steering as
  \`hookSpecificOutput.additionalContext\`: a shell read of indexed source gets one \`find_symbol(relativePath:)\`
  nudge per file per turn, a re-read of lines already returned one note; it records on PostToolUse (shell and
  \`${TEA_RAGS_MCP_TOOL_MATCHER}\`), turns on UserPromptSubmit, drops its ledger on SessionStart compact / clear.
  UserPromptSubmit \`\${PLUGIN_ROOT}/scripts/turn-routing.sh --harness codex\` — the routing lines of
  \`scripts/turn-routing.txt\` as \`hookSpecificOutput.additionalContext\` every user turn.
- \`tea-rags/skills/\` — curated tea-rags skills (below).
- \`tea-rags/repair/\`, \`tea-rags/rules/references/\` — plugin files the skills link to by relative path.
${core}
- \`dinopowers/.codex-plugin/plugin.json\` — manifest: \`skills\`, \`hooks\` (no MCP server: the wrappers call
  the tea-rags plugin's tools).
- \`dinopowers/hooks/hooks.json\` — SessionStart \`scripts/main-session-routing.sh\` and SubagentStart
  \`scripts/wrapper-routing.sh\`, both \`hookSpecificOutput.additionalContext\` with the routing table
  (\`scripts/*.txt\`, rendered from the Claude Code hook scripts in \`$dino-<s>\` mentions).
- \`dinopowers/skills/dino-<s>/\` — the wrappers; \`dinopowers/CHAINING.md\`, \`dinopowers/FRESHNESS.md\` — files they link to.

## Install

\`\`\`bash
codex plugin marketplace add <owner/repo> --sparse .agents --sparse ${CODEX_HARNESS_DIR}
# or a local clone: codex plugin marketplace add <path to the clone root>
codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}
codex plugin add ${DINOPOWERS_NAME}@${MARKETPLACE_NAME}   # needs superpowers: https://github.com/obra/superpowers
\`\`\`

Then review the plugin hooks in \`/hooks\` (plugin hooks stay untrusted until reviewed; \`codex exec\`
takes \`--dangerously-bypass-hook-trust\` for one run). Development build instead of the global
binary: in the installed \`.mcp.json\` set \`"command": "node", "args": ["<repo>/build/index.js"]\`.

## Skills

Shipped: every user-invocable tea-rags skill, plus each internal skill a shipped skill names
(transitively) — those run inside the callers' workflows, so they ship with a short description
naming their callers. Each description ≤ ${CODEX_DESCRIPTION_MAX_CHARS} chars: Codex clips every description in its
skills list mid-word, with no warning — measured ~467–470 chars with 55 skills listed (codex-cli 0.162.1), and
the clip shrinks as the list grows. A source \`codex-description:\` (front-loaded routing triggers and NOT-clauses)
replaces \`description\` here; Claude Code and Cursor keep the full \`description\`. Skills list: ${total} chars
(\`name + description\`).

| Skill | description | name + description |
| ----- | ----------- | ------------------ |
${skillRows(skills)}

dinopowers ships every wrapper as \`dino-<s>\` (Claude Code \`dinopowers:<s>\`), clear of the superpowers skill
\`<s>\` it chains into. superpowers is not bundled: a wrapper whose superpowers skill is missing stops and asks
for the install. Same per-description cap. Skills list: ${dinoTotal} chars.

| Skill | description | name + description |
| ----- | ----------- | ------------------ |
${skillRows(dinopowers.skills)}

Combined (tea-rags + dinopowers, superpowers' own list not counted): ${total + dinoTotal} chars. The ~8,000-char
default list budget is not the binding limit — the per-description clip is.

## Transform rules

Load-time \`\` !\`…\` \`\` blocks dropped (the model-read line beside them stays);
\`ReadMcpResourceTool\` → \`read_mcp_resource\`; \`mcp__tea-rags__<tool>\` → \`<tool>\`;
\`Skill(tea-rags:<s>)\` / \`/tea-rags:<s>\` / \`tea-rags:<s>\` → \`$<s>\`; \`dinopowers:<s>\` → \`<s>\` in tea-rags,
\`$dino-<s>\` in dinopowers (\`superpowers:<s>\` → \`$<s>\` there);
Agent-tool passages → "spawn a subagent"; \`AskUserQuestion\` → ask the user;
\`CLAUDE_PLUGIN_ROOT\` → \`PLUGIN_ROOT\`, \`CLAUDE_PROJECT_DIR\` → \`PWD\`; frontmatter → \`name\` + \`description\`.

## Facts (codex-cli 0.162.1; full list with sources: \`docs/superpowers/specs/2026-10-23-harness-facts.md\` §A)

- Manifest \`.codex-plugin/plugin.json\`; paths start with \`./\` [S:codex-rs/core-plugins/src/manifest.rs].
- Plugin hooks default to \`hooks/hooks.json\`; commands get \`PLUGIN_ROOT\`, \`PLUGIN_DATA\`; untrusted until
  reviewed in \`/hooks\` [D:learn.chatgpt.com/docs/hooks].
- Plain stdout is context for SessionStart / UserPromptSubmit / SubagentStart; structured
  \`hookSpecificOutput.additionalContext\`; ~2,500 tokens per hook output [D:hooks].
- Skills list = 2% of context (8,000 chars default); descriptions shortened first, skills omitted with a
  warning [D:learn.chatgpt.com/docs/build-skills]. Measured (2026-10-26, 55 skills): each description clipped
  to ~467–470 chars, mid-word, no warning [L:codex skills-list probe].
- No manifest field bundles AGENTS.md — core rules go into a skill and a user AGENTS.md snippet.
- Resource tools: \`list_mcp_resources\`, \`read_mcp_resource{server, uri}\` [S:mcp_resource_spec.rs]; model-visible
  MCP tool names may carry an \`mcp__<server>__\` prefix — prose names tools bare. Code mode (\`code_mode_host\`,
  stable on 0.162.1) hides them behind one \`exec\` (JS) tool: \`tools.mcp__tea_rags__<tool>\`, "normalized
  JavaScript identifiers", listed in \`ALL_TOOLS\` [L:codex binary prompt text; probe 2026-10-29] —
  \`codex-rules.txt\` says so for both modes.
- Verified locally (2026-10-23): \`codex plugin --help\` → \`add | list | marketplace | remove\`;
  \`codex plugin marketplace --help\` → \`add | list | upgrade | remove\`; \`marketplace add <SOURCE>\` takes a local
  path; \`plugin add <PLUGIN[@MARKETPLACE]>\`. A local marketplace root holds \`.agents/plugins/marketplace.json\`
  with \`source.path\` relative to the root [L:~/.codex/.tmp/bundled-marketplaces/openai-bundled].
- \`.mcp.json\` \`type\`: stdio entries in shipped plugins carry no \`type\` (3 of 3); only the HTTP entry has
  \`"type": "http"\` [L:~/.codex/plugins/cache/**/.mcp.json] — the stdio entry here omits it.
`;
}

interface DinopowersPackage {
  version: string;
  files: Map<string, string>;
  skills: ShippedSkill[];
}

/** `dinopowers/**`: wrappers as `$dino-<s>`, routing tables at SessionStart and SubagentStart. */
function renderCodexDinopowers(root: string, teaRagsSkills: ReadonlySet<string>): DinopowersPackage {
  const pluginRoot = join(root, DINOPOWERS_SRC);
  const manifest = readManifest(pluginRoot);
  const mentionable = new Set([...teaRagsSkills, ...wrapperNames(root)]);
  const { files, skills } = renderDinopowersSkills(
    root,
    { skill: toCodexSkill, text: (md, names) => toHarnessText(md, CODEX_DIALECT, names, true) },
    mentionable,
  );
  const hooks: Record<string, unknown[]> = {};
  for (const [event, hook] of [
    ["SessionStart", ROUTING_HOOKS.mainSession],
    ["SubagentStart", ROUTING_HOOKS.subagent],
  ] as const) {
    const context = toHarnessText(hookContext(root, hook.script, hook.variable), CODEX_DIALECT, mentionable, true);
    const script = hook.text.replace(/\.txt$/, ".sh");
    files.set(`${DINOPOWERS_NAME}/scripts/${hook.text}`, `${context}\n`);
    files.set(`${DINOPOWERS_NAME}/scripts/${script}`, routingScript(event, hook.text));
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${PLUGIN_ROOT_VAR}/scripts/${script}`,
            timeout: 10,
            statusMessage:
              event === "SessionStart"
                ? "Dinopowers: load workflow routing"
                : "Dinopowers: load subagent workflow routing",
          },
        ],
      },
    ];
  }
  files.set(
    `${DINOPOWERS_NAME}/.codex-plugin/plugin.json`,
    json({
      name: DINOPOWERS_NAME,
      version: manifest.version,
      description: manifest.description,
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
    }),
  );
  files.set(
    `${DINOPOWERS_NAME}/hooks/hooks.json`,
    json({ description: "Dinopowers workflow routing for sessions and subagents", hooks }),
  );
  return { version: manifest.version, files, skills };
}

/**
 * The whole Codex package as `path (relative to harness/codex) → content`,
 * Prettier-formatted like the committed files, so a regeneration leaves no diff.
 */
export async function renderCodexHarness(root: string): Promise<Map<string, string>> {
  const pluginRoot = join(root, PLUGIN_SRC);
  const manifest = readManifest(pluginRoot);
  const corePath = join(pluginRoot, "rules/core.md");
  const hasCore = existsSync(corePath);
  const selected = selectSkills(readSkills(pluginRoot));
  const skillNames = new Set(selected.map(({ skill }) => skill.name));
  if (hasCore) skillNames.add(CORE_SKILL);

  const files = new Map<string, string>();
  const shipped: ShippedSkill[] = [];
  for (const { skill, callers } of selected) {
    const description = skill.internal ? internalDescription(skill, callers, CODEX_DIALECT.skillMention) : undefined;
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? toCodexSkill(source, { skillNames, name: skill.name, description })
          : file.endsWith(".md")
            ? toHarnessText(source, CODEX_DIALECT, skillNames)
            : source;
      files.set(`${PLUGIN_NAME}/skills/${skill.name}/${rel}`, out);
    }
    const rendered = parseFrontmatter(files.get(`${PLUGIN_NAME}/skills/${skill.name}/SKILL.md`) ?? "").fields;
    shipped.push({ name: skill.name, description: rendered.description });
  }
  for (const file of linkedPluginFiles(
    pluginRoot,
    selected.flatMap(({ skill }) => walk(skill.dir)),
  )) {
    const source = readFileSync(file, "utf8");
    const out = file.endsWith(".md") ? toHarnessText(source, CODEX_DIALECT, skillNames) : source;
    files.set(`${PLUGIN_NAME}/${relative(pluginRoot, file)}`, out);
  }

  if (hasCore) {
    const coreRules = withCodexPrelude(
      withCodexGuideReads(
        toHarnessText(parseFrontmatter(readFileSync(corePath, "utf8")).body, CODEX_DIALECT, skillNames),
      ),
      CODEX_READ_DISCIPLINE,
    );
    const core = coreRules + CODEX_SKILL_LOADING;
    files.set(`${PLUGIN_NAME}/skills/${CORE_SKILL}/SKILL.md`, renderFrontmatter(CORE_SKILL, CORE_DESCRIPTION) + core);
    files.set("AGENTS.tea-rags.md", core);
    files.set(`${PLUGIN_NAME}/scripts/core.txt`, coreRules);
    files.set(`${PLUGIN_NAME}/scripts/codex-rules.txt`, CODEX_SKILL_LOADING.replace(/^\n+/, ""));
    shipped.unshift({ name: CORE_SKILL, description: CORE_DESCRIPTION });
  }

  const block = extractInjectionBlock(readFileSync(join(pluginRoot, "rules/references/subagent-injection.md"), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.txt`, `${toHarnessText(block, CODEX_DIALECT, skillNames)}\n`);
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.sh`, SUBAGENT_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/one-file-read.sh`, ONE_FILE_READ_SCRIPT);
  for (const script of SHARED_HOOK_SCRIPTS) {
    files.set(`${PLUGIN_NAME}/scripts/${script}`, readFileSync(join(pluginRoot, "scripts", script), "utf8"));
  }
  const turnRouting = extractInjectionBlock(readFileSync(join(pluginRoot, TURN_ROUTING_SOURCE), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/turn-routing.txt`, `${toHarnessText(turnRouting, CODEX_DIALECT, skillNames)}\n`);
  files.set(`${PLUGIN_NAME}/scripts/session-start.sh`, proseHookScript("core.txt"));
  files.set(`${PLUGIN_NAME}/scripts/session-codex-rules.sh`, proseHookScript("codex-rules.txt"));
  files.set(`${PLUGIN_NAME}/scripts/session-digest.sh`, SESSION_DIGEST_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/fit-digest.py`, FIT_DIGEST_SCRIPT);

  files.set(
    `${PLUGIN_NAME}/.codex-plugin/plugin.json`,
    json({
      name: PLUGIN_NAME,
      version: manifest.version,
      description: manifest.description,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
    }),
  );
  files.set(
    `${PLUGIN_NAME}/.mcp.json`,
    json({
      mcpServers: {
        [PLUGIN_NAME]: { command: "tea-rags", args: ["server"], default_tools_approval_mode: "approve" },
      },
    }),
  );
  files.set(
    `${PLUGIN_NAME}/hooks/hooks.json`,
    json({
      description: "TeaRAGs context, code navigation and read tracking",
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/session-start.sh`,
                timeout: 10,
                statusMessage: "TeaRAGs: load core rules",
              },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/session-codex-rules.sh`,
                timeout: 10,
                statusMessage: "TeaRAGs: load Codex context policy",
              },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/session-digest.sh`,
                timeout: 60,
                statusMessage: "TeaRAGs: load project digest",
              },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: `${LEDGER_COMMAND} --harness codex`,
                timeout: 10,
                statusMessage: "TeaRAGs: initialize read ledger",
              },
            ],
          },
        ],
        SubagentStart: [
          {
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/subagent-block.sh`,
                timeout: 30,
                statusMessage: "TeaRAGs: load subagent context",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/turn-routing.sh --harness codex`,
                timeout: 5,
                statusMessage: "TeaRAGs: route this request",
              },
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/search-drift.sh --harness codex`,
                timeout: 5,
                statusMessage: "TeaRAGs: reset search tracking",
              },
              {
                type: "command",
                command: `${LEDGER_COMMAND} --harness codex`,
                timeout: 5,
                statusMessage: "TeaRAGs: advance read ledger",
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: SHELL_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/one-file-read.sh`,
                timeout: 10,
                statusMessage: "TeaRAGs: check document read size",
              },
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/search-drift.sh --harness codex`,
                timeout: 10,
                statusMessage: "TeaRAGs: check search scope",
              },
              {
                type: "command",
                command: `${LEDGER_COMMAND} --harness codex`,
                timeout: 10,
                statusMessage: "TeaRAGs: check reused code",
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: TEA_RAGS_MCP_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${PLUGIN_ROOT_VAR}/scripts/search-drift.sh --harness codex`,
                timeout: 5,
                statusMessage: "TeaRAGs: record search results",
              },
              {
                type: "command",
                command: `${LEDGER_COMMAND} --harness codex`,
                timeout: 10,
                statusMessage: "TeaRAGs: remember delivered MCP code",
              },
            ],
          },
          {
            matcher: SHELL_TOOL_MATCHER,
            hooks: [
              {
                type: "command",
                command: `${LEDGER_COMMAND} --harness codex`,
                timeout: 10,
                statusMessage: "TeaRAGs: remember delivered shell code",
              },
            ],
          },
        ],
      },
    }),
  );
  const dinopowers = renderCodexDinopowers(root, skillNames);
  for (const [path, content] of dinopowers.files) files.set(path, content);
  files.set("README.md", readme(manifest.version, shipped, hasCore, dinopowers));

  return formatPackage(root, CODEX_HARNESS_DIR, files);
}

/**
 * The root Codex marketplace manifest: one entry per package folder under
 * `harness/codex/`, `source.path` relative to the repository root.
 */
export async function renderCodexMarketplace(
  root: string,
  packages: readonly string[] = HARNESS_PACKAGES,
): Promise<string> {
  return formatRootFile(
    root,
    CODEX_MARKETPLACE_PATH,
    json({
      name: MARKETPLACE_NAME,
      interface: { displayName: "tea-rags" },
      plugins: packages.map((name) => ({
        name,
        source: { source: "local", path: `./${CODEX_HARNESS_DIR}/${name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      })),
    }),
  );
}

/** Replace `harness/codex/` with a fresh render and rewrite the root marketplace manifest. */
export async function writeCodexHarness(root: string): Promise<number> {
  const count = writePackage(root, CODEX_HARNESS_DIR, await renderCodexHarness(root));
  writeRootFile(root, CODEX_MARKETPLACE_PATH, await renderCodexMarketplace(root));
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const count = await writeCodexHarness(root);
  console.log(`✓ ${CODEX_HARNESS_DIR}: ${count} files regenerated from ${PLUGIN_SRC}, ${DINOPOWERS_SRC}.`);
}
