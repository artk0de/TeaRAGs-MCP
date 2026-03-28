#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="${1:-.}"

# Validate path exists
if [ ! -d "$PROJECT_PATH" ]; then
  echo "Directory does not exist: $PROJECT_PATH" >&2
  exit 1
fi

# Resolve to absolute path
PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"

# ---------------------------------------------------------------------------
# File count (excluding noise dirs)
# ---------------------------------------------------------------------------
FILE_COUNT=$(find "$PROJECT_PATH" \
  \( -name node_modules -o -name .git -o -name vendor -o -name dist -o -name build \) -prune \
  -o -type f -print | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------
# LOC estimate
# ---------------------------------------------------------------------------
SOURCE_EXTENSIONS="\( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.rb' \
  -o -name '*.java' -o -name '*.go' -o -name '*.rs' -o -name '*.cs' \
  -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \
  -o -name '*.kt' -o -name '*.scala' -o -name '*.swift' -o -name '*.php' \)"

if command -v cloc >/dev/null 2>&1; then
  LOC_ESTIMATE=$(cloc --quiet --sum-one \
    --exclude-dir=node_modules,.git,vendor,dist,build \
    "$PROJECT_PATH" 2>/dev/null | tail -1 | awk '{print $NF}' || echo "0")
else
  LOC_ESTIMATE=$(find "$PROJECT_PATH" \
    \( -name node_modules -o -name .git -o -name vendor -o -name dist -o -name build \) -prune -o \
    \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rb" \
       -o -name "*.java" -o -name "*.go" -o -name "*.rs" -o -name "*.cs" \
       -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.hpp" \
       -o -name "*.kt" -o -name "*.scala" -o -name "*.swift" -o -name "*.php" \) \
    -type f -print0 2>/dev/null | xargs -0 wc -l 2>/dev/null | tail -1 | awk '{print $1}' || echo "0")
fi

LOC_ESTIMATE="${LOC_ESTIMATE:-0}"

# ---------------------------------------------------------------------------
# Git analysis
# ---------------------------------------------------------------------------
IS_GIT_REPO="false"
TOP_AUTHOR="null"
AUTHOR_COMMIT_COUNT="null"
HAS_FREQUENT_COMMITS="false"
AVG_GAP_MINUTES="null"
GIT_ENABLED="false"
SQUASH_AWARE="false"

if git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IS_GIT_REPO="true"
  GIT_ENABLED="true"

  # Get last 200 commits: format = "AuthorName|UnixTimestamp"
  GIT_LOG=$(git -C "$PROJECT_PATH" log --format='%an|%at' -200 2>/dev/null || true)

  if [ -n "$GIT_LOG" ]; then
    # Find dominant author (most commits)
    TOP_AUTHOR_RAW=$(echo "$GIT_LOG" | cut -d'|' -f1 | sort | uniq -c | sort -rn | head -1)
    AUTHOR_COMMIT_COUNT=$(echo "$TOP_AUTHOR_RAW" | awk '{print $1}')
    TOP_AUTHOR_NAME=$(echo "$TOP_AUTHOR_RAW" | sed 's/^ *[0-9]* //')

    # Escape for JSON
    TOP_AUTHOR_ESCAPED=$(echo "$TOP_AUTHOR_NAME" | sed 's/"/\\"/g')
    TOP_AUTHOR="\"$TOP_AUTHOR_ESCAPED\""

    # Get timestamps for dominant author, sorted ascending
    AUTHOR_TIMESTAMPS=$(echo "$GIT_LOG" | awk -F'|' -v author="$TOP_AUTHOR_NAME" '$1==author {print $2}' | sort -n)

    # Compute consecutive gaps in minutes
    if [ -n "$AUTHOR_TIMESTAMPS" ]; then
      GAPS=$(echo "$AUTHOR_TIMESTAMPS" | awk '
        NR > 1 {
          gap = ($1 - prev) / 60
          if (gap >= 0) print gap
        }
        { prev = $1 }
      ')

      if [ -n "$GAPS" ]; then
        # Median gap: sort numerically, pick middle
        GAP_COUNT=$(echo "$GAPS" | wc -l | tr -d ' ')
        MID=$(( (GAP_COUNT + 1) / 2 ))
        MEDIAN_GAP=$(echo "$GAPS" | sort -n | sed -n "${MID}p" | awk '{printf "%.0f", $1}')

        AVG_GAP_MINUTES="$MEDIAN_GAP"

        if [ "$MEDIAN_GAP" -lt 30 ] 2>/dev/null; then
          HAS_FREQUENT_COMMITS="true"
          SQUASH_AWARE="true"
        fi
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Build recommendedEnv
# ---------------------------------------------------------------------------
RECOMMENDED_ENV="{\"TRAJECTORY_GIT_ENABLED\":\"${GIT_ENABLED}\""
if [ "$SQUASH_AWARE" = "true" ]; then
  RECOMMENDED_ENV="${RECOMMENDED_ENV},\"TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS\":\"true\""
fi
RECOMMENDED_ENV="${RECOMMENDED_ENV}}"

# ---------------------------------------------------------------------------
# Output JSON
# ---------------------------------------------------------------------------
if [ "$IS_GIT_REPO" = "true" ]; then
  printf '{"isGitRepo":true,"fileCount":%s,"locEstimate":%s,"topAuthor":%s,"authorCommitCount":%s,"hasFrequentCommits":%s,"avgGapMinutes":%s,"recommendedEnv":%s}\n' \
    "$FILE_COUNT" \
    "$LOC_ESTIMATE" \
    "$TOP_AUTHOR" \
    "$AUTHOR_COMMIT_COUNT" \
    "$HAS_FREQUENT_COMMITS" \
    "${AVG_GAP_MINUTES:-null}" \
    "$RECOMMENDED_ENV"
else
  printf '{"isGitRepo":false,"fileCount":%s,"locEstimate":%s,"topAuthor":null,"authorCommitCount":null,"hasFrequentCommits":false,"avgGapMinutes":null,"recommendedEnv":%s}\n' \
    "$FILE_COUNT" \
    "$LOC_ESTIMATE" \
    "$RECOMMENDED_ENV"
fi
