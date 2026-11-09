# Phase 3g — DEPENDENCY NORMS — architecture-diagnostics

Loaded by `SKILL.md` Phase 3g.

`response.norms` exists ONLY when the request carried `norms: true` — skip
otherwise. The project judged by ITS OWN precedents: ledgers of (roleSrc,
roleDst, locality) over every typed file edge, ONE LEDGER PER LANGUAGE FAMILY
(`norms.ledgers[]`; TypeScript + JavaScript are one family, every other language
its own) — a Ruby `form` and a TS `form` never pool. Each ledger runs own
direction test (`ledgers[].significance`, method `directionInversion`): per
unordered role pair {A, B}, A ≠ B, localities pooled, exact two-sided sign test
of n(A→B) vs n(B→A) at p = ½; Benjamini–Hochberg at `q` (0.05, co-change gate's
q) over every pair holding ≥1 edge (`familySize`). Pair BH rejects
(`significantPairCount`) has ESTABLISHED direction; every edge against it =
MISFIT. `oneWayPairCount` = significant pairs nothing runs against — direction
fixed, no finding. Everything else CONFORMS, not listed: mutual pair (62:61),
one-way pair, pair too small to establish anything (3:0, 2:1 never reach q),
same-role pair (A→A, out of scope). NEW_PATTERN (pair with no history) is NOT
whole-repo verdict — diff time only. `finding.family` names judging ledger. Edge
between two families never judged (`summary.excluded.crossLanguageEdgeCount`).
Roles = each file's PRIMARY type's role; `summary.roleFileCount` counts strong
ones, `weakRoleFileCount` / `untypedFileCount` never judge. Of weak ones,
`summary.ioShapeRoleFileCount` = files whose primary type only shapes I/O of
function file is named for (`useXParams`, `XProps`) — never a role.

| Finding  | Read as                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `misfit` | edge runs against pair's established direction — `establishedDirection: { roleSrc, roleDst, support }` is the way the project goes (`Record -> Query` when `Query -> Record` holds 52:6) |

Every finding carries `pairSupport` (edges along the finding's own direction,
localities pooled — minority side), `establishedDirection.support` (majority)
and `pValue` (sign test, 3 significant digits). `pairSupport: 1` against
`support: 24` = strong; heavy minority (24 against 47) = established but
contested convention — read before calling it a mistake. `locality` = where THIS
edge sits (`sameDirectory` / `sameDomain` / `crossDomain`); test pools
localities, so it never changes the verdict.

`summary.excluded.inheritanceEdgeCount` — typed edges from a file whose primary
type subclasses the target's primary type (STI subclass → own base record):
"is-a", not a role dependency — never judged, in no ledger.

`summary.excluded.constantReferenceEdgeCount` — typed edges whose only evidence
is a constant NESTED in the target's primary type
(`BaseAdapter::RateLimitError`, no definite call): a dependency on an error
class, not on the target's role — never judged, in no ledger.

`summary.excluded.uncalledEdgeCount` — typed edges carrying NO resolved call
(`callWeight` 0: factory `.new`, subtype registry, initializer config, type-only
import). Source names target, never runs its logic → never a finding. Still
ledger precedent: direction of knowledge counts every reference (a query reads
records through framework finders with no in-project call, yet that IS what
establishes query → record).

`summary.excluded.frameworkRoutedEdgeCount` — typed edges whose EVERY call went
through framework interface: call text names neither member it lands on nor its
owner's construction, along no inheritance edge (`Worker.perform_async(id)`
routed to `Worker#perform`). Source knows target's framework contract, not its
logic → never a finding; still precedent. Caveat: a project's own dispatcher
routing `Service.call(x)` → `#perform` reads the same.

`summary.excluded.displacedRoleEdgeCount` — typed edges touching a DISPLACED
role: head-noun role read where role does not live — file outside every
conventional directory of its role (`app/lib/x/fee_helper.rb` while helpers live
in `app/helpers`), or called on type itself (`class << self`) while role's home
carriers are called on instances (or reverse). Role stays precedent, edge never
judged. Edge-level reasons (constant, uncalled, framework-routed) count first.

`pathPattern` scopes the FINDINGS by source — ledgers and the test stay
whole-graph. Findings it drops count in `summary.outOfScopeFindingCount`, never
silently lost.
