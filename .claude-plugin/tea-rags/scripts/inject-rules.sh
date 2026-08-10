#!/usr/bin/env bash
# SessionStart/PreCompact hook: put the search-cascade rule corpus into the
# agent's context. The corpus is ~37KB and a hook's stdout stops being delivered
# well before that — past roughly 16KB the harness writes it to a file and hands
# the model a 2KB preview instead, so a single `cat` of the corpus reaches the
# model as its first two kilobytes and nothing else.
#
# The corpus is therefore emitted in parts, one hook command per `--part N`, each
# below --max-bytes. Parts are packed on `## ` section boundaries so a rule is
# never cut in half; a section larger than the budget is split by lines. Callers
# declare how many slots they wired with --parts, and the last slot names any
# rules that did not fit rather than dropping them silently.
#
# A hook must never fail the session: always exit 0.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
RULES_DIR="$PLUGIN_ROOT/rules"

# Order is the reading order: the cascade first, the two it defers to after.
RULE_FILES="search-cascade.md index-freshness.md language-compatibility.md"

MAX_BYTES=10000
PART=0
PARTS=0
COUNT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --part)       PART="${2:-0}";        shift 2 || shift ;;
    --parts)      PARTS="${2:-0}";       shift 2 || shift ;;
    --max-bytes)  MAX_BYTES="${2:-10000}"; shift 2 || shift ;;
    --count)      COUNT_ONLY=1;          shift ;;
    *)                                   shift ;;
  esac
done

PATHS=""
for f in $RULE_FILES; do
  [ -f "$RULES_DIR/$f" ] && PATHS="$PATHS $RULES_DIR/$f"
done
[ -n "$PATHS" ] || exit 0

# No --part and no --count: a caller that was not updated still gets everything.
if [ "$COUNT_ONLY" = 0 ] && [ "$PART" = 0 ]; then
  for f in $PATHS; do
    cat "$f"
    echo
  done
  exit 0
fi

# shellcheck disable=SC2086
awk -v part="$PART" -v parts="$PARTS" -v maxb="$MAX_BYTES" -v countonly="$COUNT_ONLY" \
    -v paths="$PATHS" '
function push(text, len) { nb++; btxt[nb] = text; blen[nb] = len }

function flush() {
  if (buf != "") push(buf, buflen)
  buf = ""; buflen = 0
}

# Budget headroom for the part marker and the overflow notice, which are printed
# on top of whatever the blocks add up to.
function budget() { return maxb - 500 }

function add(line,   l) {
  l = length(line) + 1
  if (buf != "" && buflen + l > budget()) { push(buf, buflen); buf = ""; buflen = 0 }
  buf = buf line "\n"
  buflen += l
}

function pack(   i, p, cur) {
  p = 1; cur = 0
  for (i = 1; i <= nb; i++) {
    if (cur > 0 && cur + blen[i] > budget()) { p++; cur = 0 }
    ppart[i] = p
    cur += blen[i]
  }
  total = p
}

FNR == 1 {
  flush()
  file = FILENAME
  sub(/.*\//, "", file)
  # Names the file each segment came from, so its cross-references still resolve
  # when a reader meets the segment on its own.
  add("<!-- source: rules/" file " -->")
}

/^## / { flush(); add($0); next }

{ add($0) }

END {
  flush()
  pack()

  if (countonly) { print total; exit }
  if (part < 1 || part > total) exit

  marker = "<!-- tea-rags rules — part " part "/" total
  if (part > 1) marker = marker ", continuing the previous hook output"
  print marker " -->"

  for (i = 1; i <= nb; i++)
    if (ppart[i] == part) printf "%s", btxt[i]

  if (parts > 0 && total > parts && part == parts) {
    gsub(/^ +/, "", paths)
    gsub(/ +/, ", ", paths)
    print ""
    print "<!-- Parts " parts + 1 "-" total " have no hook slot to arrive in. Read these files directly: " paths " -->"
  }
}
' $PATHS

exit 0
