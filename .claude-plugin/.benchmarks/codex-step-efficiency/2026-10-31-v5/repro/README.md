# Controller IO reproduction and future A-only adapters

This directory contains the portable Python persistence helper, focused offline tests,
and the v5 preparation/launch adapters. No auth, corpus, model answers or live run
artifacts are bundled. `protocol.py` and the native transport/schema adapter are
byte-for-byte copies of validated v4; `v4-source-provenance.json` records their
source hashes. The original v4 directory and run evidence are unchanged.

## Offline verification

Use the explicit reviewed interpreter, not `python3` from an arbitrary PATH:

```sh
/opt/homebrew/bin/python3 -m unittest discover -s PATH_TO_REPRO -p 'test_*io.py' -v
```

The 16 tests exercise opaque event fidelity/order (including duplicates), a hard
process crash after flush, truncated-tail detection, one completion/error snapshot,
linear journal byte growth, overwrite refusal, runtime mismatch, and no-client
runner/launch integration, optimized-interpreter rejection across four entrypoints,
and collector-failure exit propagation. Test RPCs are in-memory fakes; no actors are started.

`controller_io.py` appends one compact JSONL record and flushes once per event.
It does not keep a second growing event list. The native protocol's original list
remains unchanged and supplies the one completed `Qnn-events.json` snapshot.
Caught errors generate one `Qnn-partial-events.json` snapshot from the journal.
Hard process crashes retain `Qnn-partial-events.jsonl` for read-only recovery with
`recover_journal(path)`. Incomplete final-record bytes are reported explicitly;
corrupt complete records raise. Recovery does not resume or retry an actor.
The global RPC `events.jsonl` remains authoritative. No fsync/power-loss guarantee
is made. Snapshots are atomically published through an exclusive same-directory
hard link, so an existing evidence file is never replaced.

## Runtime freeze and future launch

The adapters require `/opt/homebrew/bin/python3` resolving to Python 3.15.
Preparation records the running executable's resolved path, SHA256, version,
implementation cache tag and flags in `controller-python.json` and the manifest.
Both the identity record and executable join `frozen_files`. Launch verifies the
actual runtime and the identity record before consuming ROOTGO or creating RPCs.
A different PATH interpreter, executable bytes, flags or version fails closed.
Optimized Python (`-O` or `PYTHONOPTIMIZE`) is explicitly refused even when its
identity matches the frozen record, because the inherited safety gates use assertions.
`job.py` now requires an explicit `--base`; it has no default old run directory
and no import-time launch. Its child processes use the same `sys.executable`.
A collector failure retains `accounting_failed` and propagates its nonzero exit code.

For a future separately authorized preparation, use this source directory or an
exact byte-copy scratch directory and invoke its `prepare.py` with the explicit
interpreter, `--source`, a fresh `--base`, and the validated frozen `--baseline`.
Preparation retains the inherited no-model stage recovery; **actors never resume,
retry, overwrite or configure B**. `run.py --base ... --rootgo` still requires the
existing independent-review, focused-case and transport-preservation gates.
No preparation/build/proof/model launch was performed through these new A-only
repro adapters. The separate `short_native.py` behavioral actors are documented
in the parent investigation; their executions are not an A39 adapter launch.

## Persistence measurements

Marks and status include `controller_persistence`, labeled `OBSERVATION`, with
append/snapshot wall seconds, thread CPU seconds, byte counts and event counts.
These measurements overlap RPC/service activity. They are never subtracted to
claim pure model time. The inherited corpus-verification accounting is unchanged.

`evidence/real-Q01-io-replay.json` records one approved opaque real Q01 replay using
the same explicit Python 3.15 for old and new persistence. The old `dump` function
is extracted verbatim from the retained v4 runner AST without importing its RPC.
The replay compares all events in order, prints no payloads, and removes temporary
raw journals. Only aggregate counts, timings, hashes and limitations are retained.
It does not explain the historical timing gap or measure live model efficiency.
Old-then-new order, filesystem cache and system load remain uncontrolled.

The red tests and subsequent green results are preserved in `evidence/`.
`adapter-io-initial-harness-attempt.txt` is retained as a harness-error attempt;
only `adapter-io-red.txt` is the valid assertion-based adapter RED run.
The tea-rags graph review did not return before cancellation; no graph-based
clean verdict is claimed. All changes here are new benchmark/repro files.


## Readiness-only protocol correction

`mcp_readiness.py` now gates the SAME actor RPC/thread between thread/start and
turn/start. The native 0.166 schema supports threadId, serverName=tea-rags and
detail=toolsAndAuthOnly. A connected inventory must contain exactly the 17 frozen
real tools, with no toolsError or pagination. Starting-state waits block on native
startup notifications with a deadline and no sleeps; unrelated/pending events
remain in the original protocol queue. Missing/failed/incomplete inventory aborts
before a model turn.

The seven new targeted readiness tests passed after RED, and the four affected
adapter pins passed after fixture-only updates for the new inventory and timeout
contract. Earlier IO/optimization/collector evidence remains retained. The first
adapter-pin run exposed a stale fake RPC signature (timeout keyword), preserved as
`mcp-readiness-adapter-pins-green.txt`; the valid result is `...-green-02.txt`.

A fresh no-model native probe of the actual helper returned connected17 in the
same thread before any turn. This proves runtime/inventory readiness, not that a
code-mode ALL_TOOLS snapshot race caused historical extra model responses. In the
old actors turn/start preceded startup-ready; an empty catalog query could still
execute after ready, while direct known MCP calls succeeded. Naming predicates
alone do not explain the difference: later normalized names also contain tea_rags.

The optional CLI fallback is NOT FIXED. A fresh isolated experiment showed the
policy shell PATH overriding the RPC launch PATH. Setting that PATH and allowing
exact transport files made command-v succeed, but a real read-only resource CLI
still failed Python sibling-module discovery. Protected cases/grading/controller
and auth-symlink opens remained denied. No directory grants were added. Root
chose readiness-only isolation: those experimental PATH/file grants are NOT in
this runner or the new short controller; original shell/FS/proxy boundaries stay
unchanged. The native 17-tool MCP route has positive readiness evidence.

The new short controller is a separate `.tmp/codex-speed-v5-evals/short_native_ready.py`;
old c160991a short controller and all original prepared/actor directories remain
unchanged. Its readiness helper is copied/frozen in each new profile. Only two
fresh no-model ready-baseline profiles are to be prepared; model turns require a
new explicit root GO. No model outcome or whole-environment success is claimed.
