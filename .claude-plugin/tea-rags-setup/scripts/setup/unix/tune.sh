#!/usr/bin/env bash
set -euo pipefail

EMBEDDING_PROVIDER="${1:-onnx}"

DEFAULTS_JSON='{"EMBEDDING_BATCH_SIZE":"32","QDRANT_UPSERT_BATCH_SIZE":"100","INGEST_PIPELINE_CONCURRENCY":"1"}'
OLLAMA_DEFAULTS_JSON='{"EMBEDDING_BATCH_SIZE":"256","QDRANT_UPSERT_BATCH_SIZE":"100","INGEST_PIPELINE_CONCURRENCY":"1"}'

if [ "$EMBEDDING_PROVIDER" = "onnx" ]; then
  printf '{"status":"skipped","values":%s}\n' "$DEFAULTS_JSON"
  exit 0
fi

if [ "$EMBEDDING_PROVIDER" = "ollama" ]; then
  ENV_FILE="tuned_environment_variables.env"

  # Run tune, non-critical — capture exit code
  EMBEDDING_PROVIDER=ollama npx tea-rags tune >/dev/null 2>&1 || {
    echo "tune command failed, using ollama defaults" >&2
    printf '{"status":"error","values":%s}\n' "$OLLAMA_DEFAULTS_JSON"
    exit 0
  }

  if [ ! -f "$ENV_FILE" ]; then
    echo "tuned_environment_variables.env not found after tune, using ollama defaults" >&2
    printf '{"status":"error","values":%s}\n' "$OLLAMA_DEFAULTS_JSON"
    exit 0
  fi

  # Parse KEY=VALUE lines from env file into JSON
  VALUES_JSON=$(awk -F= '/^[A-Z_]+=/ {
    key=$1
    val=substr($0, index($0,"=")+1)
    gsub(/"/, "\\\"", val)
    printf "\"%s\":\"%s\",", key, val
  }' "$ENV_FILE" | sed 's/,$//')

  rm -f "$ENV_FILE"

  if [ -z "$VALUES_JSON" ]; then
    echo "Failed to parse tune env file, using ollama defaults" >&2
    printf '{"status":"error","values":%s}\n' "$OLLAMA_DEFAULTS_JSON"
    exit 0
  fi

  printf '{"status":"completed","values":{%s}}\n' "$VALUES_JSON"
  exit 0
fi

echo "Unknown embedding provider: $EMBEDDING_PROVIDER. Expected: ollama|onnx" >&2
printf '{"status":"error","values":%s}\n' "$DEFAULTS_JSON"
exit 0
