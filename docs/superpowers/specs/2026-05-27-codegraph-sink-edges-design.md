# Codegraph Sink Edges — Agent-Assisted Dynamic Dispatch Resolution

> Status: Design (approved 2026-05-27). Topic owner: codegraph trajectory.
> Scope: cross-language mechanism, Ruby as the first (and v1-only) detector.

## Problem

The static call-graph walker/resolver cannot resolve dynamic dispatch. Ruby is
the worst offender: `obj.send(method_name)` with a non-literal argument,
`method_missing`-based delegation, `define_method(var)`, `const_get(var)`, and
`eval`-family constructs all defeat static resolution. The resolver's design
philosophy is **drop rather than guess** (`ruby-resolver.ts:143,157`) — so these
call sites produce **no edge**, silently. The call graph is incomplete in
exactly the places where a human (or an agent that can read runtime behaviour)
_could_ supply the missing edge.

Today `obj.send(x)` (variable argument) is worse than dropped: the walker fails
to unwrap it (`ruby-walker.ts:638` → `extractLiteralSymbolOrString` returns
`null`) and falls through to emit a **garbage** `member="send"` edge
(`ruby-walker.ts:664`) that the resolver then drops or mis-resolves.

## Goal

Offload dynamic-dispatch resolution to a coding agent without polluting the
graph with guesses:

1. **Static analysis recognizes the gap** — the walker marks call sites it knows
   are dynamic dispatch (it can _recognize_ the construct even though it can't
   _resolve_ the target).
2. **Gaps are recorded as sink candidates** — written to a DuckDB table during
   indexing, scoped to the source file.
3. **The agent fills them via CLI** — `tea-rags codegraph override`, validated
   against the recorded candidates (cannot add an edge where no gap exists).
4. **Filled edges are marked `sink`** in the graph (provenance), surfaced
   transparently by `get_callees` / `get_callers`.
5. **File-hash gating** keeps sink edges alive while the file is unchanged and
   invalidates them when it changes — riding the existing incremental-reindex
   lifecycle for free.

## Non-goals

- **Not** capturing every resolver `null`. Correct drops (AR-relation chains
  `ruby-resolver.ts:143`, cross-language pollution `pl7k`, strict-mode ambiguous
  drops) are **not** gaps — surfacing them would drown the agent in noise and
  invite wrong edges. Only constructs the walker **recognizes as dynamic
  dispatch** become candidates.
- **Not** a git-tracked override file. Sink edges live in DuckDB only; they are
  local to whoever ran indexing and not shared across clones. (Accepted
  trade-off — see Limitations.)
- **Not** durable across edits to the source file. A sink edge dies when its
  file's hash changes and the candidate re-surfaces. (Accepted trade-off — the
  whole invalidation model is hash-based by design.)

## Core framing

**Every sink candidate is an outgoing-edge gap anchored at a source symbol.**
Detection is broad (many dynamic constructs); the override semantics are
uniform: `override` always inserts one or more `source → target` method edges
and removes the candidate. This keeps validation and the write path uniform
regardless of which dynamic construct produced the gap.

## Architecture

### Data flow

```
ingest pass-2 (resolveExtraction / streamingResolveAndUpsert)
  walker emits CallRef.unresolvableKind   ← instead of garbage member="send"
        │
        ▼
  provider sees the marker → writes a row to cg_sink_candidates
        │                     (scoped to file; rides upsertFile lifecycle)
        ▼
  tea-rags codegraph gaps <path>          → agent reads candidates (CLI)
        │
        ▼
  agent inspects runtime behaviour, determines target symbol(s)
        │
        ▼
  tea-rags codegraph override <path> --candidate <id> --target <symbolId> [...]
        │   validate: candidate id exists → else reject
        ▼
  daemon → GraphDbClient.addSinkEdge: INSERT edge origin='sink' + DELETE candidate
        │
        ▼
  get_callees / get_callers return the edge annotated origin:"sink"
```

### Gap taxonomy (v1 — full statically-recognizable Ruby set)

`unresolvableKind` is an **extensible** string enum. Each kind annotates _why_
the dispatch is dynamic; all reduce to "this source symbol has outgoing edge(s)
the resolver could not produce." v1 Ruby detector set:

| `gapKind`               | Recognized construct                                  | Anchor (source symbol)           |
| ----------------------- | ----------------------------------------------------- | -------------------------------- |
| `dynamic_send`          | `recv.send(var)` / `public_send` / `__send__` non-lit | enclosing method (the call site) |
| `method_object`         | `method(:x)` / `recv.method(var)` later `.call`       | enclosing method                 |
| `define_method_dynamic` | `define_method(var) { … }` with non-literal name      | enclosing class/module           |
| `method_missing`        | class defines `method_missing`                        | the `method_missing` symbol      |
| `eval_dispatch`         | `instance_eval` / `class_eval` / `eval` with code     | enclosing method                 |
| `const_get_dynamic`     | `const_get(var)` / `Object.const_get(var)`            | enclosing method                 |

The walker is the **single recognition point** (per codegraph-walkers rule: the
walker extracts, the resolver resolves). The set is extensible per language —
adding a kind = one walker branch + one row here, no schema change.

### Components (change map)

| #   | Change                                                                         | Location                                                                                         | Kind               |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------ |
| 1   | `CallRef.unresolvableKind?: GapKind` (+ optional `gapHint?`)                   | `contracts/types/codegraph.ts`                                                                   | type-only field    |
| 2   | Ruby walker emits gap-marked CallRefs for the v1 detector set                  | `ingest/pipeline/chunker/extraction/ruby-walker.ts`                                              | replace `send` arm |
| 3   | `cg_sink_candidates` table + write from the resolution loop                    | `adapters/duckdb/` (schema+migration), `codegraph/.../provider.ts`                               | +table +migration  |
| 4   | `origin` column (`'static' \| 'sink'`) on method-edge rows                     | edge schema in `adapters/duckdb/`                                                                | +migration         |
| 5   | `listSinkCandidates` + `addSinkEdge` on `GraphDbClient`, proxied via daemon    | `contracts/types/codegraph.ts`, `adapters/duckdb/`, daemon `protocol.ts`/`client.ts`/`server.ts` | +methods           |
| 6   | CLI `codegraph gaps` (list) and `codegraph override` (fill, validated)         | `src/cli/`                                                                                       | +commands          |
| 7   | `origin` surfaced on `CalleeEdge` / `CallerEdge`                               | `contracts/types/codegraph.ts` + read path                                                       | +field             |
| 8   | Language gating: gaps emitted only for supported languages; CLI rejects others | walker registry / CLI                                                                            | gate               |

### Storage

**`cg_sink_candidates`** (new). One row per recognized gap, scoped to the source
file so it rides the existing per-file `upsertFile` DELETE+INSERT lifecycle:

| Column             | Notes                                                        |
| ------------------ | ------------------------------------------------------------ |
| `candidate_id`     | Stable within an index build; referenced by `override`.      |
| `source_symbol_id` | Anchor symbol (caller method / class / method_missing).      |
| `source_rel_path`  | File scope — the row is deleted when this file is re-walked. |
| `gap_kind`         | One of the taxonomy values.                                  |
| `call_text`        | Source text of the construct (e.g. `obj.send(name)`).        |
| `receiver`         | Receiver text when present (`obj`), else null.               |
| `start_line`       | 1-based line of the construct.                               |
| `language`         | Gating + display.                                            |

**Method edges** gain `origin TEXT NOT NULL DEFAULT 'static'`. Sink edges are
written with `origin='sink'`. Because edges are keyed by source file and rebuilt
by `upsertFile`, sink edges are wiped exactly when their file changes.

### Validation

`override` accepts an edge **only if `--candidate <id>` exists** in
`cg_sink_candidates`. No matching candidate → reject
(`no recognized gap at this location`). Fan-out is allowed: one candidate may
take multiple `--target` (a `send(var)` can legitimately reach several methods).
On success: insert each `source_symbol_id → target` edge with `origin='sink'`,
then delete the candidate row.

### Lifecycle (file-hash gating — free)

- File **unchanged** → `upsertFile` not called → sink edges + candidates
  persist.
- File **changed** → `upsertFile` DELETE+INSERT → sink edges wiped, candidates
  re-emitted → agent re-fills.
- **force-reindex** → full rebuild → all sink edges gone, all candidates fresh.

### Write path through the daemon

DuckDB's RW lock is process-exclusive (the reason the codegraph daemon exists).
`addSinkEdge` / `listSinkCandidates` are added to the `GraphDbClient` surface
and proxied through the daemon protocol like the rest of the surface — the CLI
talks to the daemon, never opens DuckDB directly while the daemon holds the
lock.

### CLI surface

```
tea-rags codegraph gaps <path> [--language ruby] [--path-pattern <glob>] [--kind <gapKind>]
    → compact list: candidate_id, source_symbol_id, gap_kind, call_text, line

tea-rags codegraph override <path> --candidate <id> --target <symbolId> [--target <symbolId> ...]
    → validate candidate exists → insert sink edge(s) → remove candidate
```

Both commands route through the daemon-backed `GraphDbClient`. CLI-only (no MCP
tool) per the token/tool-call budget decision.

## Reads

`get_callees` / `get_callers` return `origin` on each edge so consumers can tell
a human/agent-supplied `sink` edge from a statically-proven `static` edge. The
existing `targetSymbolId: null` (file-only) semantics are unchanged and
orthogonal.

## Limitations (explicit)

1. **Not durable across edits.** A sink edge dies when its source file's hash
   changes; the candidate re-surfaces and the agent must re-resolve. Fine for
   stable files, churny for hot files. This is the chosen invalidation model.
2. **Local, not shared.** Sink edges/candidates live in DuckDB, not git — they
   are not shared across clones or CI. A teammate's clone re-derives candidates
   and must re-fill.
3. **Trust boundary.** A sink edge is an _assertion_ by an agent, not a proof.
   `origin='sink'` marks it so downstream consumers (metrics, presets) can weigh
   it differently if needed. v1 treats sink edges identically to static for
   fan-in/fan-out; differential weighting is a follow-up.

## Testing strategy

- **Walker**: each v1 gap kind emits a CallRef with the right `unresolvableKind`
  and does **not** emit the old garbage `member="send"` edge
  (`ruby-walker.test.ts`).
- **Provider/resolution**: a gap-marked CallRef writes a `cg_sink_candidates`
  row instead of attempting resolution; correct drops (AR-relation, cross-lang)
  do **not** produce candidates (`provider.test.ts` / resolver tests).
- **Adapter**: `addSinkEdge` inserts `origin='sink'` + deletes candidate
  atomically; `listSinkCandidates` returns scoped rows; `upsertFile` wipes both
  on re-walk (`duckdb` adapter tests).
- **Daemon**: `addSinkEdge` / `listSinkCandidates` round-trip through the
  protocol.
- **CLI**: `override` against a non-existent candidate is rejected; against a
  valid candidate inserts the edge and the candidate disappears from `gaps`.
- **End-to-end (self-test index)**: index a Ruby fixture with `obj.send(var)`,
  confirm a candidate appears in `gaps`, `override` it, confirm `get_callees`
  returns the edge with `origin:"sink"`, re-index the unchanged file → edge
  survives; edit the file → edge gone, candidate back.

## Open follow-ups (out of v1)

- Differential weighting of `sink` vs `static` edges in metrics/presets.
- Other languages' dynamic-dispatch detectors (Python `getattr`, JS bracket
  dispatch, etc.) — the mechanism is language-agnostic; only the walker
  detectors are per-language.
- Optional git-tracked export of sink edges for sharing/CI (rejected for v1).
