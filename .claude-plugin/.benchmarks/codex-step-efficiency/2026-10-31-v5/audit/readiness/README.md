# Readiness-only no-model evidence extension

This archive extends the initial audit without rewriting its manifest. It
contains 23 byte-exact allowlisted artifacts plus this README and a separate
manifest. RPC event journals/stderr were copied opaquely and were not parsed,
printed or interpreted during packaging. No model actors, tests, proofs,
indexing, replay or implementation changes were performed for this archive.

## Preserved evidence

- `mcp-readiness-native-proof.json`: existing aggregate proof, source hashes,
  limitations and the readiness-only decision.
- `schema/`: five schemas exported from the exact frozen Codex CLI 0.166.0,
  executable SHA256
  `39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1`.
- `probes/`: every one of the 11 diagnostic scripts/results explicitly listed
  in that proof's `artifacts_sha256`, with matching original hashes.
- `journals/`: no-model RPC events/stderr for probe01's failed handshake,
  probe02's actual readiness-helper connection, and probe03's narrow CLI
  experiment. Probe02's separate shell diagnostics are retained byte-for-byte
  under `probes/`, including the invalid /usr/bin/test attempt.

Only the allowlist is archived. Auth files, actor homes, full profile configs,
runtime binaries and private upstream stderr are excluded. The
`narrow-profile-experiment.json` artifact is metadata only: before/after config
hashes, exact allowed file paths, no-directory-grants and model-turn counters.
It contains no profile configuration body.

## Attempts remain distinct

**Probe01 failed.** The fresh diagnostic harness omitted codex61_cli.py even
though its generated shim invoked that file, so MCP handshaking closed. The
script and failed inventory remain; this is not evidence against the native
readiness API.

**Probe02 established same-thread readiness.** The complete frozen transport
copy returned connected plus the exact 17 real tool names before any turn.
A separate check using the actual new helper recorded native call order
thread/start then mcpServerStatus/list, with model requests disabled and no
turn started. The local schema supports exact threadId, serverName=tea-rags,
detail=toolsAndAuthOnly, runtimeStatus, toolsError and native startup updates.
The helper requires complete inventory, not a ready notification alone.

Probe02 also exposed an independent CLI limitation: the native policy shell
PATH omitted the shim despite its presence in the RPC launch PATH. The no-login
shell check failed even with an explicit launch PATH. Its /usr/bin/test
readability subcheck was invalid on this macOS system; that command failure is
preserved and **is not permission-denial proof**.

**Probe03 did not fix CLI fallback.** In a fresh scratch-only experiment,
matching the shell PATH and allowing exact transport files made command-v
positive. A real read-only resource CLI still failed Python sibling-module
discovery with ModuleNotFoundError. Five existing protected controls returned
EPERM using open/close without reading contents; one additional nonexistent
control returned ENOENT and is not counted as denial evidence.

Root chose a **readiness-only correction**. The probe03 PATH/file permission
experiment is not carried into the future runner or new short controller.
Original shell/FS/proxy/native-backend boundaries remain unchanged. No
directory grants or CLI transport redesign follow from this archive.
**CLI fallback remains NOT FIXED.** Do not treat command-v positivity as an
end-to-end CLI proof or claim the entire environment is fixed.

## Interpretation limits

Old short actors began their turn before startup-ready. Some empty ALL_TOOLS
queries executed later, after native ready, while direct known-name MCP calls
could already succeed. Later normalized names still contain tea_rags, so the
broader name predicate alone does not explain the difference. These observations
are consistent with a request-time catalog snapshot/projection race, but the
no-model probes cannot prove that causal mechanism or a model-efficiency gain.

All probe work recorded here has model_turns=0. Any later ready-baseline model
case outcomes belong to separately authorized and archived evidence. No
candidate-success claim is made. The diagnostic scripts are preserved as
historical source, **not instructions to rerun or broaden permissions**.

`manifest.json` records each archived artifact's source path, byte size and
SHA256; copied diagnostic/source hashes match the proof allowlist. Its payload
count excludes the manifest itself. The initial parent audit manifest continues
to cover its original snapshot; this extension has its own manifest.
