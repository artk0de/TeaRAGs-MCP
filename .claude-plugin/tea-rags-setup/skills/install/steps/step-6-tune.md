# Step 6: Tune Performance

**Pre-check before tuning:**

- If embeddingProvider is "ollama" → verify `ollama --version` succeeds and
  `ollama list` shows the model. If not → remind user to start Ollama.
- If qdrantMode is "docker" or "native" → verify
  `curl -sf http://localhost:6333/healthz`. If not → remind user to start
  Qdrant.
- If qdrantMode is "embedded" → no check needed (tea-rags starts it).

Invoke the `/tea-rags-setup:tune` skill. It will:

1. Run `tea-rags tune` with the provider from step 4
2. Parse results and save to progress file
3. Show summary to the user

The tune skill reads `embeddingProvider` and `qdrantMode` from the progress file
automatically. If tune fails — non-critical, save defaults from `reference.md`
"Tune Defaults" table and continue.

Warn the user: "Performance tuning failed. Using conservative defaults — you can
re-run `/tea-rags-setup:tune` later to optimize."
