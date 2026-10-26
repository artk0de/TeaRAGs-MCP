# Phase 3b — LEAKING ABSTRACTION — architecture-diagnostics

Loaded by `SKILL.md` Phase 3b.

Module = dir with entry file (`index.ts`/`index.tsx`/`index.js`, `__init__.py`,
`mod.rs`/`lib.rs`). Boundary judged ONLY where importers adopted facade: ≥3
external importers AND adoption > 0.5 AND adoption ≥ adaptive cut.

| Summary field (`summary.leakingAbstraction`) | Read as                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adoptionThreshold`                          | cut this codebase got; adoption must ALSO be > 0.5                                                          |
| `adoptionThresholdMethod`                    | `otsu` = split over module adoptions; `majority` = too few modules (< 8) or adoptions not bimodal (η < 0.8) |
| `adoptionSeparability`                       | η of the cut; near 1 = clean two-mode split. Present under `majority` too = the η that failed the gate      |
| `activeModules`                              | modules whose boundary is judged, with facade/deep importer counts                                          |
| `notAdoptedModules`                          | facade exists, importers ignore it — name, don't judge                                                      |

`rootCauses` with `detector: "leakingAbstraction"` = one per module:
`violationCount`, `bypassCount`, `internalReachCount`, `sources`. Read first.

| `kind`           | Meaning                                                               | Fix direction                                   |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `bypass`         | facade exposes all importer takes — importer could use facade, didn't | switch import to facade                         |
| `internal-reach` | facade does not expose it — importer reaches unoffered code           | export it via facade OR question the dependency |

Kind decided by NAMES when index recorded them (`evidence.importedNames`):
facade exposes = names it re-exports (`export {a} from`, `export *` = all;
`__init__.py` also exposes what it imports). Any name not exposed →
`internal-reach`, listed in `evidence.nonExportedNames`. No names on either edge
(pre-names index, side-effect import) → file rule: facade imports target =
`bypass`. `importedNames` absent → kind is file-level, say so.

Evidence per line: `moduleDir` (innermost active module leaked past),
`facadeRelPath`, `adoption`, facade/deep importer counts, `callWeight` (0 =
type/const-only import).

`kind: "conventionPrivacy"` — privacy compiler does not enforce, broken anyway.
Evidence `sourceSymbolId`, `targetSymbolId`, `rule`:

| `rule`              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `python-underscore` | `_name` member (not dunder) called from other package directory            |
| `ruby-send-private` | `send`/`public_send`/`__send__(:name)` into private/protected, other class |

Counts: `summary.leakingAbstraction.conventionPrivacy` (`candidateEdgeCount`,
`violationsByRule`). No module root cause — list per symbol pair. Candidates
come from resolved method edges only: unresolved call → not judged.
