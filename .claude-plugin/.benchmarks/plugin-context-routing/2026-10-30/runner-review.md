# Independent runner preflight review

Reviewed `run.py`, its `codex61_app_rpc.py` transport, and the actor-context schemas before any actor turn.

PASS for actor-input separation: compilation selects only the request, retained raw messages and fixture files/tool responses. Expected answers, grading, assertions and suite method text are not sent to the actor. Compiled fixture/controller files are outside the actor workspace and the native profile defaults to deny. Source files are bounded by a path-containment assertion.

PASS for isolation and authorization structure: each case has a fresh CODEX_HOME and isolated workspace, backend-only auth symlink, native plugin installation with byte inventory verification, enabled trusted plugin hooks, restricted shell environment, network disabled and no host/project instruction discovery. A manifest ROOTGO gate precedes turns. Exclusive actor-directory creation and the all-cases no-prior-actor guard prevent retries or overwrites. Transport rejects model requests during preparation and rejects approval requests.

The requested model is exactly gpt-6.1-sol with medium effort in configuration and turn arguments. No-turn preflight asserts the returned model and effort. Requested follow-up: repeat that returned-model assertion for the actual worker thread before its model turn, rather than relying only on the earlier thread and logged request values.

Requested additional denial probes for the fixture server and grading-bearing suite JSON, alongside existing controller/fixture/actor/auth probes. Runtime evidence must retain actual hook execution events: trusted registration alone does not prove a hook ran. Native responses must retain returned bodies; request IDs alone do not prove a successful body retrieval.

Batch workflow grading uses the executed wrapper and observed per-file operations. Native overlap is supporting evidence; scheduler serialization or insufficient timer resolution makes concurrency timing unverified without changing a correct Promise batch into a workflow failure. Artificial delays are absent.

Fixture limits: parsed relativePath lookups return outlines even for short files; source bodies remain available through exact ids. Graph defaults return explicit noEdgeFixture rather than real call edges. The runner executes the current plugin arm only, so these results cannot establish a baseline delta or real-graph behavior.

Final go remains conditional on successful no-turn native boundary/plugin/MCP proofs and the actual-worker model assertion. No actor/model turn was initiated by this reviewer.
