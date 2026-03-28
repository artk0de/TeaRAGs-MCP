#!/usr/bin/env bash
set -euo pipefail

PROGRESS_DIR="$HOME/.tea-rags"
PROGRESS_FILE="$PROGRESS_DIR/setup-progress.json"

usage() {
  echo "Usage: progress.sh init" >&2
  echo "       progress.sh get [<dotpath>]" >&2
  echo "       progress.sh set <dotpath> <value>" >&2
  exit 1
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
fi

case "$cmd" in
  init)
    mkdir -p "$PROGRESS_DIR"
    started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    jq -n \
      --arg startedAt "$started_at" \
      '{
        version: 1,
        startedAt: $startedAt,
        platform: null,
        arch: null,
        versionManager: null,
        packageManager: null,
        nodePath: null,
        npmPath: null,
        embeddingProvider: null,
        qdrantMode: null,
        projectPath: null,
        projectLocEstimate: null,
        gpu: null,
        steps: {
          detect:    { status: "pending" },
          node:      { status: "pending" },
          "tea-rags":{ status: "pending" },
          embedding: { status: "pending" },
          qdrant:    { status: "pending" },
          tune:      { status: "pending" },
          analyze:   { status: "pending" },
          configure: { status: "pending" },
          verify:    { status: "pending" }
        }
      }' | tee "$PROGRESS_FILE"
    ;;

  get)
    if [[ ! -f "$PROGRESS_FILE" ]]; then
      echo "progress file not found: $PROGRESS_FILE" >&2
      exit 1
    fi
    dotpath="${2:-}"
    if [[ -z "$dotpath" ]]; then
      cat "$PROGRESS_FILE"
    else
      jq_path=".$(echo "$dotpath" | sed 's/\./\./g')"
      jq "$jq_path" "$PROGRESS_FILE"
    fi
    ;;

  set)
    if [[ $# -lt 3 ]]; then
      echo "set requires <dotpath> and <value>" >&2
      exit 1
    fi
    if [[ ! -f "$PROGRESS_FILE" ]]; then
      echo "progress file not found: $PROGRESS_FILE" >&2
      exit 1
    fi
    dotpath="$2"
    value="$3"
    jq_path=".$(echo "$dotpath" | sed 's/\./\./g')"

    # Detect if value is valid JSON (object, array, string literal, number, boolean, null)
    if echo "$value" | jq -e . >/dev/null 2>&1; then
      updated="$(jq --argjson v "$value" "${jq_path} = \$v" "$PROGRESS_FILE")"
    else
      updated="$(jq --arg v "$value" "${jq_path} = \$v" "$PROGRESS_FILE")"
    fi

    echo "$updated" > "$PROGRESS_FILE"
    echo '{"status":"ok"}'
    ;;

  *)
    usage
    ;;
esac
