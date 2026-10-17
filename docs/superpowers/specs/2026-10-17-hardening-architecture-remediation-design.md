# Design: Architecture Hardening Remediation

- **Epic**: `tea-rags-mcp-54xwd` — eliminate all above-low architecture
  violations
- **Date**: 2026-10-17
- **Inputs**: `get_architecture_report` @ `c92ca2d` (overlay `23b42fc`), plan
  `docs/superpowers/plans/2026-10-17-architecture-violation-remediation.md`,
  `find_cycles`, per-family repair recipes in `.claude-plugin/tea-rags/repair/`
- **Scope**: 30 above-low items (24 violation rows + 6 runtime import cycles)
  across 14 beads. The 21 low items (bundles with expectedSupport ≥ 0.15,
  barrel-vs-subfolder layout cycles, the type-only 12-file contracts cycle,
  islands) are out of scope by owner decision.
- **Target**: zero violations above low on a fresh report.

## 1. Solution shape

Three waves, ordered by how much each wave changes the graph the next wave is
judged on.

- **Wave 1 — mechanical relocations and edge breaks** (beads `.1`, `.2`, `.12`,
  `.13`, `.14`). Self-contained moves with simulated or recipe-shaped ops. Every
  landing shifts the component partition, so Wave 2 re-measures.
- **Wave 2 — identification-gated** (beads `.5`, `.6`, `.7`, re-scope of `.8`,
  `.11`). The report does not name the affected components; each starts with a
  scoped `get_architecture_report` / `architecture-diagnostics` pass, then
  applies its recipe.
- **Wave 3 — dependency inversion and contracts** (beads `.3`, `.4`, `.10`).
  Design decisions in this document; code follows the decided shape.

Re-report after each wave. The execution contract in the plan governs per-Task
verification; waves add one more gate: a full report between waves, re-run
through `restructurePlan` for anything still open.

## 2. Wave 1

### 2.1 Merge `src/mcp/tools` into `src/core/api` (`.1`, plan Task 1)

Simulated: resolved 4 (two structural SDP, two shotgun bundles), introduced 2,
net −2, blast 306.

Move set — 18 files plus the two leaf utilities they depend on:

- `src/mcp/tools/**` → `src/core/api/tools/**` (substructure preserved: `code/`,
  `formatters/`)
- `src/mcp/format.ts` → `src/core/api/tools/format.ts`
- `src/mcp/middleware/error-handler.ts` →
  `src/core/api/tools/middleware/error-handler.ts`

Rationale for absorbing `format` and `middleware`: the tools files import both
(`../format.js`, `../middleware/error-handler.js`). Moving tools alone would
leave `api → src/mcp` imports — a new edge in the wrong direction (mcp is the
server layer that imports api, never the reverse). `src/mcp/prompts/` and
`src/mcp/resources/` stay in `src/mcp` unless they import tools internals;
implementation checks their imports first and moves any file that does (rule:
_everything that imports `tools/` or `format/` follows, except the server entry
itself_).

Introduced-facade handling. The simulation expects
`leakingAbstraction.facade: bootstrap/factory.ts → mcp/tools/index.ts` after the
merge. This design neutralizes it inside the same Task: `src/core/api/index.ts`
(the api facade) re-exports `registerAllTools`, and `bootstrap/factory.ts`
imports from the facade, not the moved file. Expected realized delta: resolved ≥
4, introduced ≤ 1 — better than simulated on the introduced side; per the
execution contract, fewer introductions than expected is not divergence.

What this does not fix: `silentCoupling` pairs involving
`mcp/tools/codegraph.ts` are file-pair facts and survive the move — they are
re-scoped under `.11` on the post-merge graph.

### 2.2 Extract `CollectionFootprintPort` (`.2`, plan Task 2)

Simulated: resolved 1 structural SDP, introduced 0, net −1, blast 83.

- New file `src/core/contracts/types/collection-footprint.ts` declaring:
  - `ResolvedCollection` — moved from `footprint/artifact.ts` (it is already
    contract-shaped: it imports `contracts/types/collection-identity` only)
  - `CollectionFootprintPort` — the factory/cloner surface worktree actually
    uses (`cloneCollectionFootprint` + `CollectionFootprintFactory` reduced to
    one port interface; name confirmed by the lexicon against the project's
    `Port` suffix)
- `footprint/artifact.ts` and `footprint/factory.js` import the types from
  contracts and keep the implementations; `footprint/index.ts` re-exports.
- `worktree-provisioner.ts` stops importing `footprint/index.ts`; it takes
  `footprint: CollectionFootprintPort` through its construction options.

Wiring point: `worktree-provisioner.ts` has file fanIn 1 — exactly one importer
constructs or re-exports it, found during implementation. The rule: the port
instance is injected at the first component boundary (the consumer of the
worktree component, i.e. the composition code that already imports footprint),
never from inside `worktree/`. The graph edge `worktree → footprint` disappears;
`wiring-site → footprint` replaces it at a component whose direction is legal.

### 2.3 Composition-cycle back-edges (`.12`, `.13`)

Same mechanical pattern in two places, highest cost first:

- `api → api/internal/ops/review-sections` (cost 0.849): review-sections files
  import the api parent barrel for types/helpers; retarget each to the specific
  leaf module it needs (`../<leaf>.js` instead of the barrel), or move the
  genuinely shared types into `contracts/types/`. The parent's import of
  review-sections stays — that direction is the composition edge.
- `cli → cli/commands` (cost 0.782): identical; commands import leaf modules,
  the cli entry keeps composing.

### 2.4 Runtime import cycles (`.14`)

One cycle per commit, move-the-declaration-to-the-leaf:

| Cycle                                                            | Break                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `qdrant/aliases ↔ connection`                                    | the shared alias type moves to the file that does not import the other |
| `qdrant/schema-metadata-point ↔ client`                          | schema point is the leaf; client imports it, never back                |
| `explore/working-tree substitute ↔ overlay`                      | shared delta types to a third leaf file                                |
| `symbols run-global-map-registry ↔ pass1-aggregates ↔ run-state` | the registry key type moves to a leaf; the 3-cycle collapses           |
| `ingest file-processor ↔ file-ingestor`                          | the processor interface moves to a leaf; ingestor implements           |
| `api app-factory ↔ api/index.ts`                                 | app-factory imports the specific api files it needs, not the barrel    |

## 3. Wave 2 — identification-gated

Each starts with a scoped diagnostic (pathPattern-limited report or layer map),
then applies its recipe. No ops are drafted before the component is named.

- **`.5` hubLike**: scoped report over the ingest cluster names H (38 files,
  afferent 9 / efferent 13). Then per `hubLike.md`: cluster consumers by
  imported-name subset, per cluster `addFile` an abstract interface beside H,
  retarget consumers to it, H imports the interface. Prefer a contracts home if
  H already imports one (efferent must not grow).
- **`.6` mainSequence 0.964**: layer map names the component (A = 0, I = 0.036,
  afferent 27, efferent 1, 10 files, volatility 5.7). Remedy order: (1) audit
  for a genuine polymorphic seam — if consumers actually vary behavior, extract
  the interface (raises A); (2) if no seam exists, the zone of pain is intrinsic
  — the volatility driver (5.7 vs threshold 4) is attacked by freezing the hot
  file(s), and the finding is closed with the audit recorded in the bead. Never
  introduce a fake interface to game the metric.
- **`.7` mainSequence 0.503**: same identification; per `mainSequence.md` judge
  evidence edges one at a time — retarget what fails the SDP rule, cite the rule
  each passing edge satisfies. Threshold flap (≤ 0.02) may dissolve after
  Wave 1.
- **`.8` re-scope**: language-walker bundles (expectedSupport ≈ 0) are the
  lockstep of parallel language substrates. Structural remedy is landing the
  shared substrate (existing P0 bead `tea-rags-mcp-zkd96`, LanguageFactory
  decoupling) — re-judge the bundles after it lands. Merges are off the table:
  every language merge simulated net +1…+10.
- **`.11` re-scope**: the two borderline silent-coupling roots are re-judged on
  the post-merge graph; Task 1 likely reshapes or resolves the
  `mcp/tools/codegraph.ts` root.

## 4. Wave 3 — dependency inversion and contracts

### 4.1 `bootstrap/auto-update → api` via constructor injection (`.3`, decision D1)

The SDP (Δ 0.329) is mixed: types already declare in stable leaves; the runtime
names declare inside api.

Design: **injection at the bootstrap boundary, not relocation**.

- `trigger.ts` and `mcp-hint.ts` take their runtime dependencies as an injected
  context: `{ resolveCollection, resolveDomainEnvCodeDefaults, freshness }`
  (types via `IndexFreshnessCheck`/`IndexFreshnessVerdict` imported from
  `maintenance/freshness` — a retarget to the declaring leaf).
- `bootstrap/factory.ts` — which already imports both api functions and
  constructs the auto-update pieces — passes them in. The `auto-update → api`
  component edge disappears; the replacing edges (`bootstrap → api`, already
  present and SDP-legal at Δ 0.11) carry the dependency.
- `AUTO_UPDATE_RUN_TTL_MS` retargets to its declaring file if outside api, else
  moves beside the trigger as auto-update-owned.

Rejected alternative: relocating `resolveCollection` into `explore`. It would
move one edge but leaves `resolveDomainEnvCodeDefaults` (cross-domain
aggregator: ingest + trajectory-git) with no honest home — its job is
composition-time aggregation, and composition-time code belongs behind
injection, not in a domain.

### 4.2 `api → composite/presets` (`.4`, decision D2)

Recommendation: **absorb into api**, mirroring Task 1's pattern. Facts: afferent
1 (only `api/internal/composition.ts` imports `buildCompositePresets`), pure
data declarations, no cross-trajectory imports (string keys only, per its own
docblock). Absorbed, the component edge vanishes and the parentSurface false
positive dissolves rather than being suppressed. The 14 efferent edges are
type/data imports api already carries at efferent 57.

Fallback (if the absorb turns out to entangle): accept-and-document — record the
parentSurface triage verdict in the bead plus a rule citation, close the bead as
accepted. The detector will keep listing the pair; the owner accepts that
residue explicitly.

### 4.3 Silent-coupling contract extraction (`.10`)

Six roots, one shared shape: the daemon protocol/store surface versus its
consumers change together with no import between them.

- **Centerpiece `duckdb/client.ts ↔ daemon/protocol.ts` (0.703)**: the
  direct-mode facade and the daemon protocol carry the same op vocabulary.
  Extract the op contract (request/response types both sides already duplicate)
  into a leaf both import — `client.ts → contract` and `protocol.ts → contract`
  explicit edges replace the invisible coupling. If the protocol file already is
  that contract, the remedy is the single missing import in `client.ts`.
- `migrations/index.ts` (5 partners) and the `temporal-cochange-store` /
  `pair-extractor` / `op-commands` / `daemon/client` roots: same audit per root
  — find the one import that explains the co-change and add it; where no single
  import explains it, extract the shared types to a leaf. No merges.

## 5. Decision points

| #   | Decision                                                               | Recommendation                                                                                                          |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D1  | auto-update→api: injection (§4.1) vs resolver relocation               | **Injection** — cheaper, composition-honest, relocation leaves the env-defaults aggregator homeless                     |
| D2  | api→composite/presets: absorb vs accept-and-document                   | **Absorb** — single-consumer pure-data leaf, same pattern as Task 1; fallback documented                                |
| D3  | mainSequence 0.964: interface extraction vs volatility freeze + accept | **Seam audit first** — extract only where consumers genuinely vary; otherwise freeze and accept with the audit recorded |

## 6. Risks

- **Parallel development**: the tree moved `c92ca2d → 23b42fc` mid-analysis and
  keeps moving (33 dirty files at last read). Wave 1 relocations touch 20+ files
  — land them on a fresh merge of master, and re-run `review_changes` against
  the actual base, not the analyzed commit.
- **Simulation drift**: all deltas are simulated against the `c92ca2d` overlay.
  The wave-boundary re-reports are the correction mechanism; per the execution
  contract, never continue on a stale plan.
- **`src/mcp` residue**: prompts/resources importing tools internals would
  extend the move set. The §2.1 rule bounds it; verify before staging.
- **Fake-abstraction temptation on `.6`**: an interface nobody implements lowers
  the metric and lies. The seam audit is the guard; D3's fallback is acceptance,
  not invention.

## 7. Verification

- Per Task: the plan's execution contract (`review_changes` on the Task base,
  compare resolved/introduced to expected, `GATE` line, ≤ 2 fix-at-write
  rounds).
- Per wave: full `get_architecture_report`; expected end state after Wave 3: SDP
  0 (or FP-accepted), hubLike 0, mainSequence ≤ 1 accepted-with-audit,
  silentCoupling ≤ 2 borderline re-scoped, composition cycles 0 above low,
  runtime cycles 0.
- Final: fresh full report; the epic closes when nothing above low remains.
