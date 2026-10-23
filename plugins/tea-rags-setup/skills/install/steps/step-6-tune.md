# Step 6: Tune Performance

**Pre-check before tuning:**

- embeddingProvider "ollama" → `ollama --version` ok + `ollama list` shows
  model. Else → remind user to start Ollama.
- embeddingProvider "llama-server" → every URL in `embeddingBaseUrl` (and
  `embeddingFallbackUrl`) answers `curl -sf <url>/health`. `tea-rags tune` CLI
  rejects llama-server — tune skill runs `-np` sweep instead, "Tune Defaults"
  minus embedding keys for rest.
- qdrantMode "docker" / "native" → `curl -sf http://localhost:6333/healthz`.
  Else → remind user to start Qdrant.
- qdrantMode "embedded" → do NOT check port 6333 (random port), do NOT wake
  daemon via MCP tool (MCP not configured yet). Only verify binary:
  `test -x "$HOME/.tea-rags/qdrant/bin/qdrant"`. `tune` skill lets
  `tea-rags tune` spawn daemon itself (`tune` section 1a — NO `--qdrant-url`
  for embedded).

Invoke `/tea-rags-setup:tune` — runs `tea-rags tune` w/ step-4 provider, saves
results to progress, shows summary (reads `embeddingProvider` + `qdrantMode`
from progress itself).

Tune fails → non-critical: save `reference.md` "Tune Defaults", continue, warn:
"Performance tuning failed. Using conservative defaults — you can re-run
`/tea-rags-setup:tune` later to optimize."
