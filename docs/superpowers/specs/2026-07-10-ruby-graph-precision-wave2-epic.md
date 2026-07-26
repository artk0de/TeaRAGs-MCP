# Ruby graph precision wave 2 — type-sources close ambiguity (EPIC)

## Thesis

Live-graph forensics on taxdome (`code_27622aef_v8`, 165 782 method edges,
2026-07-10) shows that almost all remaining noise is one root cause: **the
receiver's type is unknown at call sites where the type IS statically declared
by a macro**. The fix is not a new engine — it is feeding new **fact sources**
into the machinery that already exists (`RubyTypeFactStore`, `returnTypeOf`
chain propagation, `selfDispatchTemplates`, `cg_ambiguous_fanout` aggregates).

Measured evidence (live DuckDB probes, read-only):

| Signal | Value |
| --- | --- |
| Edges with confidence < 0.05 (pure fan-out noise) | 30 992 on 2 373 call sites (avg fan-out 13.1) |
| `firm.owner` / `@firm.owner` dynamic edges | 4 634 (vs 26 exact) |
| Ambiguous aggregate: `firm` | 1 902 sites, 411 000 candidates, max 240 |
| Ambiguous aggregate: `firm_id` (schema column) | 717 sites, 124 041 candidates |
| `result.successful?` dynamic targets | 2 128 |
| `#call` defined vs zero-caller | 85 / 71 (84 %) |
| `#perform` defined vs zero-caller | 2 473 / 352 |
| byReceiverKind missWithDef | dynamic 13 195 · bareCall 4 983 · chain 4 953 · ivar 3 188 |

## Groups (one design doc each)

| Group | Design doc | One-line |
| --- | --- | --- |
| G0 | `2026-07-10-vta-oracle-gate-design.md` | Oracle upper-bound measurement for VTA (4 buckets); numeric gate decides G5 |
| G1 | `2026-07-10-ar-association-return-types-design.md` | AR association + query-interface return types as a walker type-source |
| G2 | `2026-07-10-service-result-return-types-design.md` | Service `call` body last-expression return types (absorbs bead `lawlq.1`) |
| G3 | `2026-07-10-ambiguity-hygiene-design.md` | External-classification residual (Capybara shape), spec/ classification, conf-floor policy |
| G4 | `2026-07-10-instance-template-redirect-design.md` | Instance-rooted self-dispatch template redirect (u7d9l v3) |
| G5 | conditional — only if G0 gate fires (≥ 5 000 oracle edges) | Container element-type inference (VTA) |

Out of epic, linked as dependencies (do NOT duplicate):

- `tea-rags-mcp-wbj3` — container/VTA dispatch: closed with verdict if G0 gate
  says OUT; becomes G5's bead if IN.
- `tea-rags-mcp-va9ng` — registry-literal instantiator widening: independent
  recall track, unchanged.
- `tea-rags-mcp-lawlq.1` — absorbed by G2 (same mechanism, same bead).

## Parallel implementation plan (waves, single worktree)

### Wave 1 — four parallel streams, disjoint directories

| Stream | Files touched | Conflict points |
| --- | --- | --- |
| G0 oracle | `scripts/` (read-only harness extension) | none |
| G1 | `dsl/rails.ts`, `walker/type-sources/associations.ts`, `resolver/type-propagation.ts` | none with G4 |
| G3a | `infra/file-classification`, gem-gating in external classification | none |
| G4 | `resolver/` post-resolution redirect + `ruby-resolver.ts` wiring | `ruby-resolver.ts` is the single shared touch point with G1b |

`contracts/types/codegraph.ts` (`CallContext`) is touched by NOBODY — every
needed channel already exists (`structuredReturnTypes`, `selfDispatchTemplates`,
`localBindings`, hierarchy view). This is what makes Wave 1 safely parallel.

Each stream: TDD (RED first), measured on the in-process forensics harness
(`scripts/taxdome-codegraph-recall-forensics.ts`, ~90 s, no reindex, no qdrant).

### Wave 2 — after Wave 1 merge + ONE user-gated `--force` taxdome reindex

The single reindex also (a) persists u7d9l v2 edges (+1 795 `#perform`
targets — still absent from the live index, which was built from the pre-v2
Jul-6 build), (b) live-confirms DEFECT-1, (c) closes bead `ckjfz`.

- G2 — after G1's contribution is measured in isolation (source precedence:
  YARD > associations > body-last-expr).
- G3b conf-floor — ONLY if post-G1 residual of conf < 0.1 edges is > 5 000.
- G5 VTA — ONLY if G0 oracle total ≥ 5 000 edges.

### Measurement discipline

- Per-group harness A/B (OFF/ON) — distinct-edge-target delta + byReceiverKind;
  no denominator gaming (targets metric, not resolve-rate).
- One reindex per wave boundary, never per group. Reindex is always user-gated.
- Every group records its A/B numbers in its design doc before merge.

## Gates (fixed with user 2026-07-10)

- **VTA gate:** G0 oracle upper-bound (buckets A block-param, B `&:sym`,
  C index, D legacy-Concern) ≥ 5 000 in-project edges → G5 IN; else OUT and
  `wbj3` closes with the measured verdict.
- **Conf-floor gate:** post-G1 residual conf < 0.1 edges > 5 000 → implement
  G3b; else record verdict, skip.

## Risks

- Every dispatch file is a single-owner deep-silo — adversarial self-review +
  harness A/B per group, not green-suite-only (u7d9l lesson).
- Polymorphic associations carry no static type — sources MUST stay silent
  (no fabrication); STI resolves via existing cone.
- Wave-1 merge order: G1 and G4 both edit `ruby-resolver.ts` wiring — merge G1
  first (smaller wiring), G4 rebases its single hook.
