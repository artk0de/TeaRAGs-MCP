#!/usr/bin/env bash
# PreToolUse(Read|Bash) hook (bd tea-rags-mcp-ueplg): deny reading a file the
# tea-rags index serves — a `Read`, or a Bash `cat` / `sed` / `head` / `tail` /
# `less` / `more` of it, compounds included — and point the model at
# find_symbol instead. Prose in core.md ("never Read to read code") loses to
# Claude Code's system prompt, which presents Read as THE file tool; a deny
# decision does not.
#
# Membership is exact: `tea-rags project indexed --json` checks the file (Read:
# `--path`; Bash: every reader operand of `--command`, resolved against
# `--cwd`, in ONE call) against the snapshot of the index serving its working
# tree (registry + sharded snapshot, no Qdrant, no daemon; ~150 ms). An
# extension list never decides a deny — it only skips the CLI for obvious media
# files; a regex only skips the CLI for Bash commands naming no reader.
#
# Fail open, always: no jq, no CLI, a CLI error, unparsable output, a command
# the CLI cannot parse, a timeout (plugin.json caps the hook) — the tool call
# proceeds. A hook must never fail the tool: always exit 0.
#
# Limitation: the user's explicit manual-read order ("read it with Read",
# "руками") is invisible here — the hook sees the tool call, not the
# conversation. See plugins/tea-rags/rules/guides/freshness.md.

command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)
field() { printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; }

TEA_RAGS="${TEA_RAGS_BIN:-tea-rags}"
TOOL_NAME=$(field '.tool_name')
case "$TOOL_NAME" in
  Read)
    FILE=$(field '.tool_input.file_path')
    [ -n "$FILE" ] || exit 0
    # Media and archives are never code; skip the CLI call for them.
    case "$(printf '%s' "${FILE##*.}" | tr '[:upper:]' '[:lower:]')" in
      png | jpg | jpeg | gif | webp | bmp | ico | svg | pdf | zip | gz | tgz | tar | woff | woff2 | ttf | mp4 | mov | wav | mp3) exit 0 ;;
    esac
    case "$FILE" in
      /*) ;;
      *)
        BASE="${CLAUDE_PROJECT_DIR:-$(field '.cwd')}"
        [ -n "$BASE" ] || exit 0
        FILE="$BASE/$FILE"
        ;;
    esac
    command -v "$TEA_RAGS" >/dev/null 2>&1 || exit 0
    ANSWER=$("$TEA_RAGS" project indexed --path "$FILE" --json 2>/dev/null) || exit 0
    ;;
  Bash)
    COMMAND=$(field '.tool_input.command')
    printf '%s' "$COMMAND" | grep -qE '(^|[;&|(`[:space:]])(cat|sed|head|tail|less|more)([[:space:]]|$)' || exit 0
    CWD="$(field '.cwd')"
    CWD="${CWD:-${CLAUDE_PROJECT_DIR:-}}"
    [ -n "$CWD" ] || exit 0
    command -v "$TEA_RAGS" >/dev/null 2>&1 || exit 0
    ANSWER=$("$TEA_RAGS" project indexed --command "$COMMAND" --cwd "$CWD" --json 2>/dev/null) || exit 0
    ;;
  *) exit 0 ;;
esac

REL=$(printf '%s' "$ANSWER" | jq -r 'select(.indexed == true) | .relativePath // empty' 2>/dev/null)
[ -n "$REL" ] || exit 0
SUBJECT="${FILE:-$REL}"

REASON="$SUBJECT is indexed — read it with find_symbol(relativePath: \"$REL\") (outline; small file = full text), or find_symbol(symbols: [<the method ids you need>]) when ids are known. Read is for files outside the index."

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}' 2>/dev/null
exit 0
