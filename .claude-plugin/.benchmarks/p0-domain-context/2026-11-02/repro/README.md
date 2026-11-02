# Isolated helpers for the variant-aware harness copy

These modules do not launch models, native clients, prime, retrieval or indexing.
They are driver assets and must remain outside actor-readable fixture roots.
They do not change the source engine or the shipped plugin package.

## Replay adapter

Create `ReplayTransform(actor_id=sealed_actor_key, case_id="F01" or "F02",
project="p0-domain-context-ng1ni-external", fixture_root=sealed_absolute_fixture_root)`
once **per actor**. In that actor's scoped proxy, after the actual upstream
`find_symbol` tools/call resolves, call
`result, audit = replay.apply(actual_result, tool=actual_tool_name,
arguments=actual_arguments)`. Persist `audit` before delivering `result`.
Other cases use no adapter. Never reconstruct a request to make it match.

The adapter recognizes list/table `results` in a direct envelope,
`structuredContent`, and JSON `content[].text`. All delivered JSON body mirrors
must agree. Source text outside a supported JSON envelope is not rewritten.
Only a successfully transformed target body consumes the actor's ordinal.
Passthrough and `unexercised` never consume it. An `unexercised` outcome is an
eligibility failure for replay grading; do not quietly turn it into PASS if a
later call succeeds. Log every actual extra model tool call separately.

F01 preserves actual target body bytes; F02 changes exactly one quoted literal
on target read 1 and sets its row marker. Later reads use their actual current
upstream body. Every applied read sets global `pendingFiles=3`; existing banners
are preserved, and this adapter injects no repeat instruction. Existing stale
or degraded markers, missing/ambiguous target, wrong body needle/identity,
unsupported schemas and disagreeing mirrors fail closed with the original
response unchanged. A new table marker column pads only missing cells with null;
all original non-target cells/body bytes remain unchanged. The audit records
this schema delta. It contains hashes and public identity/status, never source.
Hashes are canonical JSON hashes, explicitly **not transport byte hashes**.

## Plugin selection

`select_plugin(spec_dict, variant, harness)` returns `root`, actual `version`,
`version_origin` and `manifest_sha256`. New specs use:

```json
{
  "variant_plugin_roots": {"candidate": {"codex": "/absolute/package"}},
  "variant_plugin_versions": {"candidate": {"codex": "0.55.2"}}
}
```

An entry `{ "root": "/absolute/package", "version": "0.55.2" }` is also
accepted. A declared variant must provide the harness and version; it cannot
silently borrow another variant's root/version. If the variant has no entry,
legacy `plugin_roots[harness]` works: optional `plugin_version` is checked, or
actual shipped metadata supplies the recorded version. There is no release
constant. Bind the returned metadata hash, full package inventory and helper
hashes into the sealed profile/proxy **before** launch; this selector is not a
substitute for sealing, actor authorization or immutable-source checks.

## Focused verification

Run `python3 -m unittest discover -s <this-directory> -p 'test_*.py'`.
Unit tests exercise actual-response-shaped public fixtures and temporary shipped
manifest files. They are not behavioral agent results, protocol integration or
semantic-ranking evidence. Failed RED attempts are retained in verification.
