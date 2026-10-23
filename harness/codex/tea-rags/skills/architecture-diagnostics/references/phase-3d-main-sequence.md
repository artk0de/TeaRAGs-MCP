# Phase 3d — MAIN SEQUENCE — architecture-diagnostics

Loaded by `SKILL.md` Phase 3d.

Stable Abstractions Principle over SAME components as SDP. A = abstract /
(abstract + concrete) types, from walker type census; I = component instability;
D = |A + I − 1|. Abstract = interface / abstract class / protocol / trait / ABC;
TS interface or object type alias counts only when exported AND declaring
behaviour (method/call signature, or majority function-typed members) — data
shapes and props are concrete-neutral, not counted. Ruby: class/module with a
`raise NotImplementedError` stub.

| `zone`        | Meaning                                                     | Fix direction                                   |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `pain`        | stable + concrete (A + I < 1) — every change hits many      | extract interfaces dependents code against      |
| `uselessness` | unstable + abstract (A + I > 1) — contracts nobody leans on | drop unused abstractions or merge into concrete |

| Summary field (`summary.mainSequence`) | Read as                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distanceThreshold` / `…Method`        | D must exceed it; `majority` = floor 0.5 decided, `otsu` = adaptive cut above (`distanceSeparability` under `majority` = η that failed the gate)                                       |
| `meanDistance`                         | whole-codebase D over judged components — trend number                                                                                                                                 |
| `abstractTypeShareByLanguage`          | abstract share per language — why a language's components are unobservable                                                                                                             |
| `volatility`                           | pain gate: `threshold`/`thresholdMethod` over mean commits per file; `fileMedian` = floor OR log population not bimodal (η < 0.8, reported); absent = gate off (no git data / no pain) |

Evidence per line: `distance`, `abstractness`, `instability`, type counts,
Ca/Ce, `unmeasuredFileCount` (> 0 = partial census, hedge), `volatility`
(`value` = mean `git.file.commitCount` per file vs `threshold`). A reported pain
component is volatile — it is rigid AND keeps changing, so it hurts now. Pain
with no `volatility` = no git reading for its files, hedge.
