# Python Imported-Receiver Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `PythonImportedNameSymbolResolutionStrategy` the receiver shape
it does not have — a receiver that is a MODULE, not a symbol.
`from netbox.tables import columns` then `columns.ColorColumn()` is 435 of
netbox's 437 `wrongFile` rows, all of them answered today by `importMatch`'s
proximity heuristic, which picks the caller's own sibling
`circuits/tables/columns.py` over the real `netbox/netbox/tables/columns.py`.
The class-receiver half (`Cls.method()`) already works and is left alone except
for the tests that pin its spellings. Then `importMatch` is demoted: it
CONTINUEs whenever the receiver head is a name an import bound, because
`importedName` has already had its say. This is E2 seam 3.

**Architecture:** No new class, no new chain pass, no walker change. One
strategy grows one private branch. `attempt` gains a SINGLE-HOP guard (the
receiver must be exactly one identifier); `resolveBinding` gains a fall-through
to `resolveModuleReceiver` for the case its `declaringFile` probe already
declines — the bound name is not a symbol any file declares, so it is a module.
`resolveModuleReceiver` composes the module text the receiver denotes, hands it
to the same `PythonImportFileMapper`, and looks the member up as a TOP-LEVEL
declaration in the file that comes back, with one `reexportOriginFile` hop.
`importMatch` gains one early CONTINUE. The binding lookup both strategies now
need moves to `strategies/shared.ts`, where the helpers used by more than one
strategy live.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest. All edits under
`src/core/domains/language/python/resolver/`, tests under
`tests/core/domains/language/python/resolver/`. Measurement through the existing
offline oracle (`scripts/py-codegraph-jedi-oracle.ts`) and chain tally
(`scripts/codegraph-chain-tally.ts`) — no reindex, no DuckDB, no live run.

**Spec:**
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
— "E2 seam 1" decision record (this seam finishes decision 4 of it, the
`importedName` pass and what `importMatch` is left holding), plus "Measurement
policy": every rate reported per corpus AND per receiverKind, never a headline
over five corpora without its per-corpus rows. Predecessor plan:
`docs/superpowers/plans/2026-09-08-python-import-file-mapper.md` (Task 5 built
the strategy this one extends; Task 6 put every import consumer on the one
mapper).

## Decision record

### E2 seam 3 — imported receivers (`9fgdi`)

All row counts below come from the integration-HEAD (`f13779956`) oracle dumps
under `/Users/artk0re/.claude/jobs/dffe3647/tmp/`: `e09/after-netbox.ndjson`,
`e09/full-b1.ndjson` (polar), `flask-lost/after-e23c-flask.ndjson`,
`flask-lost/after-httpx.ndjson`, `flask-lost/after-ugnest.ndjson`. Import-bound
shares were derived by re-reading each caller's import lines out of the corpus
and applying the walker's own binding rules (`import a.b` binds `a`;
`import a.b as c` binds `c`; `from M import x, y as z` binds `x` and `z`).

**1. `importMatch` on netbox produces 517 answers and not one of them is a
`match`.** The verdict split is 437 `wrongFile`, 60 `phantom`, 20 `chainOnly`.
482 of the 517 (93.2%) have a receiver head that an import BOUND, and they split
cleanly by import form:

| Shape                                | Rows | Verdict today                                   |
| ------------------------------------ | ---: | ----------------------------------------------- |
| `from M import mod` → `mod.Member()` |  437 | `wrongFile`, every one `receiverKind` `dynamic` |
| `import json` → `json.loads()`       |   45 | `phantom`, every one `oracleOrigin` `stdlib`    |
| receiver head bound by nothing       |   35 | 15 typeshed phantoms, 18 `chainOnly`, 2 project |

That is the whole case for this seam. The 437 are not a heuristic that is
sometimes wrong; they are a heuristic that is wrong every time it fires on this
shape, because it matches the receiver against an import's TRAILING MODULE
SEGMENT and the caller's own directory usually holds a file by that name.
Exemplar, six times over in one file: `netbox/circuits/tables/circuits.py` calls
`columns.ColorColumn()` under `from netbox.tables import columns`; the chain
answers `netbox/circuits/tables/columns.py`, jedi answers
`netbox/netbox/tables/columns.py` / `ColorColumn`.

**2. The gap is the MODULE receiver, and `declaringFile` already tells us when
we are in it.** `resolveBinding` maps the import, then asks `declaringFile`
which file DECLARES the bound name. For `from netbox.tables import columns` the
mapper answers `netbox/netbox/tables/__init__.py` and `declaringFile` answers
`null` — correctly, because `columns` is a submodule, not a symbol. Today that
`null` is a dead end (`return CONTINUE`). It is in fact the strongest signal
available: a bound name no project file declares as a symbol is a MODULE, and
the member is a top-level declaration inside it. So the new branch hangs off the
existing decline rather than off a new discriminator, which also means the
class-receiver path cannot be perturbed — it only runs when `declaringFile`
answered a file.

**3. `importedBindings` has TWO value shapes, and the module text is composed
differently from each.** Read `collectPythonImports`
(`python/walker/walker.ts:499`) rather than guessing: an `import_statement`
records the MODULE PATH as the value (`import a.b` → `{a: "a.b"}`,
`import a.b as c` → `{c: "a.b"}`, `importText` = `"a.b"` in both), while an
`import_from_statement` records the EXPORTED NAME (`from a import b` →
`{b: "b"}`, `from a import b as c` → `{c: "b"}`, `importText` = `"a"`). So
`importedBindings[local] === imp.importText` is an exact discriminator for the
module-import form, and the module a single-identifier receiver denotes is:

| Form                    | `importText` | binding   | receiver | module text denoted |
| ----------------------- | ------------ | --------- | -------- | ------------------- |
| `import a`              | `a`          | `a → a`   | `a`      | `a`                 |
| `import a.b`            | `a.b`        | `a → a.b` | `a`      | `a`                 |
| `import a.b as c`       | `a.b`        | `c → a.b` | `c`      | `a.b`               |
| `from a.b import c`     | `a.b`        | `c → c`   | `c`      | `a.b.c`             |
| `from .models import c` | `.models`    | `c → c`   | `c`      | `.models.c`         |
| `from . import c`       | `.`          | `c → c`   | `c`      | `.c`                |

Unaliased `import a.b` binds the TOP package, so the head denotes `a` and not
`a.b` — the rule is
`localName === importedName.split(".")[0] ? that first segment : importedName`.
The from-form joins, and joins WITHOUT a separator when `importText` already
ends in a dot, or `from . import c` would compose `..c` and climb a package.
This matters beyond tidiness: `from netbox import denormalized` maps its PARENT
(`netbox`) to `unknown` — a PEP 420 namespace directory — so composing the
submodule text and mapping THAT is what reaches `netbox/netbox/denormalized.py`
at all. 52 of netbox's 401 `missed` / `receiverKind: dynamic` rows are exactly
that shape.

**4. SINGLE-HOP ONLY: the receiver must be one identifier, or the pass
CONTINUEs.** `attempt` currently keys on `call.receiver.split(".")[0]` and then
throws the remaining segments away, so `Event.id.label("event_id")` looks up
`Event.label` / `Event#label` and pins `server/polar/models/event.py` for a call
that is SQLAlchemy's. Measured: on netbox every one of the 6 `importedName` rows
with a dotted receiver is a `phantom` (`Job.objects.filter(…).delete()`,
`CablePath.objects.all().delete()` — all `oracleOrigin: typeshedStub`); on polar
71 dotted-receiver rows split 58 `chainOnly` / 8 `match` / 5 `phantom`; flask,
httpx and ugnest have none at all. So a `/^[A-Za-z_]\w*$/` gate on the receiver
removes 11 measured phantoms and costs 8 matches on the one corpus whose oracle
is not yet deterministic. Multi-segment receivers, call results
(`Cls().method()`) and subscripts (`Cls.attr[k].m()`) belong to `chainType` and
the propagation seam, which fold hop by hop; a pass that reads only an import
statement has no business answering them. The gate goes in `attempt`, before the
binding lookup, so it covers every receiver-keyed branch at once.

**5. The stdlib check runs AHEAD of the mapper here, exactly as the vocabulary
already does it.** `import json` → `json.loads()` from
`netbox/utilities/forms/fields/fields.py`: the mapper's ancestor scan probes the
caller's own directories first, finds `netbox/utilities/json.py`, and answers
`project`. That is how 45 stdlib rows became in-project phantoms. The fix is not
new — `PythonExternalVocabulary.importLandsInProject` carries the identical
guard with the identical rationale (bd `mmckn`, and the navigator bullet "The
vocabulary's stdlib check runs BEFORE the mapper"). `resolveBinding` gets it
too: an ABSOLUTE `importText` whose first segment is in `PYTHON_STDLIB_MODULES`
DROPs before the mapper is asked. Absolute-import semantics make this correct
rather than merely conservative — a project module named `json.py` is reachable
as `from utilities import json`, never as `import json` — and the guard is
restricted to absolute text so a relative `.json` import is untouched. It also
delivers on the pass's own docblock, which already claims
`from json import loads` DROPs; the ancestor scan was quietly defeating that
claim.

**6. Precision rules, all four of them decline rather than guess.** No fan-out
ever. Two or more candidates for the member in the mapped module → `CONTINUE`
(`pickSingleCandidate` under the configured mode does this and nothing else).
The mapper says `external` → `DROP`, because falling through hands the call to
`globalShortName`, which resolves on short name alone and is the pass that
manufactures phantoms out of stdlib members. The mapper says `unknown` →
`CONTINUE`, keeping the three-state discipline decision 1 of the mapper plan
exists for. And a class receiver whose class does not declare the member →
`CONTINUE`, never a file-only edge: the MRO seam owns inheritance, and both of
netbox's `missed` / `receiverKind: constant` rows are that shape
(`SyncDataSourceJob.get_jobs()` where jedi answers `JobRunner.get_jobs`).

**7. The re-export hop REUSES `reexportOriginFile`; it cannot read the target
module's own imports.** The orchestrator's brief describes a Python re-export as
"the target file's own `importedBindings`", and that channel is not reachable
from here — `ctx.imports` is the CALLER's list, and the kernel helper's own
docblock says so at length. What IS reachable is the symbol table, and asking it
where a name is DECLARED is hop-count-agnostic and covers `from .x import *` for
free. So `moduleMemberTarget` falls back to the same
`reexportOriginFile(member, moduleFile, ctx, mode)` call that `declaringFile`
two lines above it already makes: one mechanism, one set of gates, no drift. Its
three gates (name must be in the table; the mapped file must not declare it
itself; the declaration must be unique, retried inside the barrel's own package)
are what keep the hop from becoming a global short-name lookup in disguise. If
the A/B in decision 10 shows `wrongFile` moving up on module receivers, this hop
is the first suspect and gating it on `moduleFile.endsWith("/__init__.py")` is
the pre-designed narrowing.

**8. The class-receiver half already ships; this seam only pins it.** Task 5 of
the mapper plan built `resolveBinding` to try `${importedName}.${member}` then
`${importedName}#${member}`, which is the classmethod/staticmethod spelling
followed by the instance spelling, and netbox measures 5,567 `match` rows
answered by `importedName` against 6 phantoms and 2 `wrongFile`. There is no
headroom left on it: the corpus holds exactly TWO `missed` rows with a
`constant` receiver and both are inheritance. So Task 2 adds tests, the
`__init__.py` re-export hop for module members, and nothing else to that branch.
The spelling rule for the tests comes from `python/kernel.ts` and
`infra/symbolid/classifyMethod`: `Cls#method` when the `function_definition`
sits in a class body undecorated, `Cls.method` when it carries `@classmethod` or
`@staticmethod`, and a bare `Name` for anything top-level — which is also why
the module-member lookup uses `symbolTable.lookup(member)` (exact symbolId) and
not `lookupByShortName`, since only a top-level declaration has the bare name as
its whole id.

**9. `importMatch` is demoted, not deleted, and this seam records what it is
left holding.** It CONTINUEs when the receiver head is a name an import bound —
`importedName` has already answered or declined with better evidence — and keeps
its proximity heuristic for receivers nothing bound: star imports, module-path
segments that merely look like the receiver, dynamic attributes. That residual
is what makes deletion a separate decision: ugnest's only two `importMatch`
`match` rows are `user.save()` in `domains/identity/services/auth/vk_login.py`,
where the import is `…models.user import User` — it binds `User`, so `user` is
UNBOUND, so the demotion leaves both answers standing. Netbox's residual is 35
rows (15 typeshed phantoms, 18 `chainOnly`, 2 project). Record the measured
residual in the bead so the next seam decides on removal from numbers rather
than from symmetry.

**10. Gates.** Unit: `npx vitest run tests/core/domains/language/python` green,
then `npm run test:coverage` exit 0. Rows: oracle A/B on netbox, flask, httpx,
ugnest with BEFORE dumps taken from the task's own base commit — gross `lost` 0,
`wrongFile` down (netbox target: the 437), `phantom` down (netbox target: the 45
stdlib rows plus the 6 dotted-receiver rows), `match` up on `dynamic` receivers.
Polar is TALLY-ONLY: its oracle is non-deterministic while three `polar`
packages are importable and the host child does not yet pin `PYTHONHASHSEED=0`
(E0.11 owns that), so quote its per-verdict tally and draw no conclusion from
it. Chain: `scripts/codegraph-chain-tally.ts --lang python` five times,
`chainDrift 0` every run. Perf: netbox A/B, wall ≤ +25%, RSS ≤ +20% — the new
work is one extra `mapImportToFile` (memoised per `<dir> <text>`) and one `Map`
lookup per module-receiver call, with no per-call allocation.

## Global Constraints

- **No walker change, no contract change, no chain reorder.** `importedName`
  stays at chain index 5 and `importMatch` at 6. Adding a pass or moving one is
  out of scope for this seam and would void the tally's drift check.
- **`importedName` never fans out and never emits a file-only edge.** Its three
  outcomes stay `resolved` / `DROP` / `CONTINUE`. `deferred` has no meaning
  here: the pass either pins a symbol or has nothing to park, and the measured
  verdict against parking `importMatch` (bd `86qfb`) is in the language
  navigator's Boundaries section.
- **Every lookup is filtered to a file.** Python symbolIds carry no module path,
  so `lookup("register")` matches every top-level `register` in the corpus; a
  candidate list that has not been narrowed by `relPath` must never reach
  `pickSingleCandidate`.
- **`ResolverConfig.mode` decides ambiguity, not the strategy.** Call
  `pickSingleCandidate(candidates, this.cfg.mode)`; do not hand-roll
  `candidates.length === 1`.
- **Existing tests are untouched** except assertions that pin `importMatch`
  answering a call whose receiver head is import-bound. Change only those, and
  only with an inline comment naming bd `tea-rags-mcp-9fgdi` and the reason.
  `.claude/rules/test-invariants.md` governs; a test that breaks for any other
  reason means the code is wrong.
- **Commits:** `feat(language): <subject> (9fgdi)`, body wrapped at 100 columns,
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer. Worktree
  only — no merge, no push, no build, no link, no reindex.
- **One fresh Opus executor per task, one worktree per task.** Tool calls ≤ 8
  minutes; writes ≤ 120 lines per call.

## File Structure

```text
src/core/domains/language/python/
  resolver/
    strategies/
      shared.ts                 MODIFIED  + PythonImportBinding, findPythonImportBinding
      python-imported-name.ts   MODIFIED  single-hop guard, stdlib DROP,
                                          resolveModuleReceiver, moduleMemberTarget
      python-import-match.ts    MODIFIED  + the import-bound CONTINUE
  CLAUDE.md                     MODIFIED  two navigator bullets (Task 4)

tests/core/domains/language/python/resolver/
  strategies/
    python-imported-name.test.ts  MODIFIED  module receiver, single hop, stdlib,
                                            re-export hop, class spellings
    strategies.test.ts            MODIFIED  only the importMatch describe block
```

Nothing else moves. `python-chain-factory.ts` is untouched, which is what keeps
both offline harnesses correct for free — they call
`createPythonSymbolResolutionChain` rather than holding their own copy of the
pass list (bd `3yxmy`), so a strategy that changes behaviour inside the chain
needs no harness edit at all.

## Context the implementer needs

**Verdict helpers** (`src/core/contracts/resolution.ts`): `CONTINUE`, `DROP`,
`resolved({ targetRelPath, targetSymbolId })`. `SymbolResolutionOutcome` is the
return type; `resolved` produces `{ kind: "resolved", target: {…} }`, which is
what the existing tests assert against.

**`ImportRef`** (`contracts/types/codegraph-extraction.ts:300–338`):
`{ importText, startLine, importedNames?: string[], importedBindings?: Record<string, string> }`.
`importedBindings` maps LOCAL name → the name the module exports, EXCEPT for
`import_statement`, where the value is the module path (decision 3's table).
Both channels are omitted rather than emitted empty. A file walked by walker
version 1 carries neither, which is why `findBinding` has a second loop over
`importedNames`.

**`PythonImportFileMapper.mapImportToFile(importText, fromFile, ctx)`**
(`resolver/python-import-file-mapper.ts`) → `{ kind: "project", relPath }` |
`{ kind: "external" }` | `{ kind: "unknown" }`. It splits on `as` and takes the
head, so passing composed module text is safe. Answers are memoised per
`<dirname(fromFile)> <moduleText>` and per symbol-table identity+size; source
roots are inferred from the table's file set. A PEP 420 namespace directory
answers `unknown`, never `project` — a directory is not a legal file-edge
target. NO DISK, ever.

**`GlobalSymbolTable`** (`contracts/types/codegraph-symbols.ts:158`):
`lookup(fqName)` is EXACT symbolId match; `lookupByShortName(name)` returns
every definition whose short name matches, across files; `hasFile(relPath)` is
membership (an empty `__init__.py` answers `true`); `hasFilesUnder(dir)` is the
namespace-package probe. `SymbolDefinition` carries
`{ symbolId, fqName, shortName, relPath, scope }` and NO kind — a `class Foo`
and a `def foo` are indistinguishable in it.

**symbolId spellings** (`python/kernel.ts` + `infra/symbolid/classifyMethod`):
scope separator `.`, so a nested class is `Outer.Inner`. A method is
`Cls#method` when it is an instance method (a `function_definition` in a class
body with neither `@classmethod` nor `@staticmethod`) and `Cls.method` when it
carries either decorator. A top-level `def`/`class` has the bare name as its
whole symbolId, with an empty `scope` — which is the property the module-member
lookup relies on.

**`reexportOriginFile(name, importedFile, ctx, mode)`**
(`domains/language/kernel/reexport-origin.ts`): returns the file that declares
`name` when `importedFile` does NOT declare it, `null` otherwise. Three gates —
the name must be in the table, the mapped file must not declare it, the
declaration must be unique (retried within the barrel's own package directory on
a global tie). Relocated from TypeScript byte-identically; do not fork it.

**`pickSingleCandidate(candidates, mode)`**
(`contracts/types/codegraph-resolution.ts:191`): `strict` returns the sole
element or `null`; `first` returns `candidates[0]`. Generic — it takes
`SymbolDefinition[]` and `string[]` alike.

**`PYTHON_STDLIB_MODULES`** (`python/vocabulary/stdlib-modules.ts`): a frozen
`ReadonlySet<string>` of top-level stdlib module names, GENERATED by
`scripts/py-oracle/gen-stdlib-modules.py`. `PythonExternalVocabulary` at
`resolver/python-external-vocabulary.ts:101` shows the ahead-of-the-mapper idiom
this plan copies.

**`classifyReceiverKind`**
(`domains/trajectory/codegraph/symbols/receiver-kind.ts`) is what buckets the
oracle rows: a lowercase single-identifier receiver bound by nothing in
`localBindings` is `dynamic` — so MODULE receivers land in `dynamic`, not in
`constant`. A capitalized single identifier is `constant`; anything with a `.`
is `chain`. Read the gate numbers accordingly: this seam moves `dynamic`.

**Test harness** (`tests/…/strategies/python-imported-name.test.ts`, top 55
lines): `tableWith({ relPath: [symbolId, …] })` builds an
`InMemoryGlobalSymbolTable` deriving `shortName` from the symbolId's last
`#`/`.` segment; `ctxWith(callerFile, imports, table)` builds the `CallContext`;
`strategy()` constructs with `{ mode: "strict" }` and a fresh mapper;
`call(receiver, member)` builds the `CallRef`.

Two fixture facts the existing cases depend on. `InMemoryGlobalSymbolTable` does
NOT dedupe: `upsertFile` pushes every definition it is given, so listing a
symbolId twice for one file is how an ambiguity case is built. And `hasFile` is
pure membership (`byFile.has`), so an `__init__.py` with an empty definition
list still makes its package mappable (bd `o7ifx`) — the test file's docblock
claiming otherwise predates that fix. Give each `__init__.py` a symbol anyway,
to match the fixtures already in the file.

## Task 1: `importedName` answers a MODULE receiver, and only single-hop ones

**Files**

- `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
- `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`

**Interfaces** — two unexported module-level functions and three private
methods; nothing new leaves the file:

```ts
const SINGLE_HOP_RECEIVER: RegExp;
function importsStdlibModule(importText: string): boolean;
function receiverModuleText(binding: ImportBinding): string;

class PythonImportedNameSymbolResolutionStrategy {
  private resolveDeclaredName(
    binding: ImportBinding,
    declaringFile: string,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome;
  private resolveModuleReceiver(
    binding: ImportBinding,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome;
  private moduleMemberTarget(
    member: string,
    moduleFile: string,
    ctx: CallContext,
  ): SymbolResolutionTarget | null;
}
```

### Steps

- [ ] RED — append a new `describe` with the three module-receiver cases below
      to
      `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`.
      Run
      `npx vitest run tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`
      and confirm all three FAIL (each returns `{ kind: "continue" }` today)
      before touching the strategy.

```ts
describe("PythonImportedNameSymbolResolutionStrategy — receiver is a module", () => {
  it("pins a top-level class in the submodule a `from pkg import mod` binding names", () => {
    const table = tableWith({
      "netbox/circuits/tables/circuits.py": ["CircuitTable"],
      "netbox/circuits/tables/columns.py": ["LocalColumn"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/tables/__init__.py": ["BaseTable"],
      "netbox/netbox/tables/columns.py": ["ColorColumn", "TagColumn"],
    });
    const ctx = ctxWith(
      "netbox/circuits/tables/circuits.py",
      [
        {
          importText: "netbox.tables",
          startLine: 3,
          importedNames: ["columns"],
          importedBindings: { columns: "columns" },
        },
      ],
      table,
    );
    // The caller's own sibling `circuits/tables/columns.py` is what
    // `importMatch`'s trailing-segment heuristic picks. The binding says
    // otherwise, 435 times on netbox (bd tea-rags-mcp-9fgdi).
    expect(strategy().attempt(call("columns", "ColorColumn"), ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "netbox/netbox/tables/columns.py",
        targetSymbolId: "ColorColumn",
      },
    });
  });

  it("binds the TOP package for an unaliased dotted `import a.b`", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "pkg/__init__.py": ["setup"],
      "pkg/sub.py": ["helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "pkg.sub",
          startLine: 1,
          importedNames: ["pkg"],
          importedBindings: { pkg: "pkg.sub" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("pkg", "setup"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "pkg/__init__.py", targetSymbolId: "setup" },
    });
  });

  it("binds the FULL module path for an aliased `import a.b as c`", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "pkg/__init__.py": ["setup"],
      "pkg/sub.py": ["helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: "pkg.sub",
          startLine: 1,
          importedNames: ["ps"],
          importedBindings: { ps: "pkg.sub" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("ps", "helper"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "pkg/sub.py", targetSymbolId: "helper" },
    });
  });
});
```

- [ ] RED — append the six remaining cases to the same `describe`. The
      namespace-parent case is the 52-row `from netbox import denormalized`
      shape and is the reason the module text is mapped INSTEAD of the parent,
      not after it.

```ts
it("composes a relative `from . import mod` without doubling the dot", () => {
  const table = tableWith({
    "pkg/__init__.py": ["setup"],
    "pkg/main.py": ["run"],
    "pkg/sub.py": ["helper"],
  });
  const ctx = ctxWith(
    "pkg/main.py",
    [
      {
        importText: ".",
        startLine: 1,
        importedNames: ["sub"],
        importedBindings: { sub: "sub" },
      },
    ],
    table,
  );
  expect(strategy().attempt(call("sub", "helper"), ctx)).toEqual({
    kind: "resolved",
    target: { targetRelPath: "pkg/sub.py", targetSymbolId: "helper" },
  });
});

it("reaches the submodule when the PARENT package is a namespace directory", () => {
  const table = tableWith({
    "netbox/circuits/apps.py": ["CircuitsConfig"],
    "netbox/netbox/__init__.py": ["VERSION"],
    "netbox/netbox/denormalized.py": ["register"],
  });
  const ctx = ctxWith(
    "netbox/circuits/apps.py",
    [
      {
        importText: "netbox",
        startLine: 2,
        importedNames: ["denormalized"],
        importedBindings: { denormalized: "denormalized" },
      },
    ],
    table,
  );
  // `netbox` itself has no `__init__.py`, so the mapper calls the PARENT
  // `unknown`; only the composed `netbox.denormalized` names a file.
  expect(strategy().attempt(call("denormalized", "register"), ctx)).toEqual({
    kind: "resolved",
    target: {
      targetRelPath: "netbox/netbox/denormalized.py",
      targetSymbolId: "register",
    },
  });
});

it("CONTINUEs on a multi-hop receiver instead of dropping the middle segment", () => {
  const table = tableWith({
    "server/polar/event/repository.py": ["EventRepository"],
    "server/polar/models/__init__.py": ["Base"],
    "server/polar/models/event.py": ["Event", "Event#label"],
  });
  const ctx = ctxWith(
    "server/polar/event/repository.py",
    [
      {
        importText: "polar.models",
        startLine: 1,
        importedNames: ["Event"],
        importedBindings: { Event: "Event" },
      },
    ],
    table,
  );
  // `Event.id.label(...)` is SQLAlchemy's; the old head-only split threw `.id`
  // away and fabricated `Event#label` (bd tea-rags-mcp-9fgdi).
  expect(strategy().attempt(call("Event.id", "label"), ctx)).toEqual({
    kind: "continue",
  });
});

it("DROPs a stdlib module receiver even when a project file shares its name", () => {
  const table = tableWith({
    "netbox/netbox/__init__.py": ["VERSION"],
    "netbox/utilities/forms/fields/fields.py": ["JSONField"],
    "netbox/utilities/json.py": ["CustomFieldJSONEncoder"],
  });
  const ctx = ctxWith(
    "netbox/utilities/forms/fields/fields.py",
    [
      {
        importText: "json",
        startLine: 1,
        importedNames: ["json"],
        importedBindings: { json: "json" },
      },
    ],
    table,
  );
  // The mapper probes the caller's ancestors first and answers
  // `netbox/utilities/json.py` — 45 phantoms on netbox. Absolute `import json`
  // is the stdlib, whatever the project happens to be named.
  expect(strategy().attempt(call("json", "loads"), ctx)).toEqual({
    kind: "drop",
  });
});

it("CONTINUEs when the module declares the member twice", () => {
  const table = tableWith({
    "app/main.py": ["main"],
    "pkg/__init__.py": ["setup"],
    "pkg/sub.py": ["helper", "helper"],
  });
  const ctx = ctxWith(
    "app/main.py",
    [
      {
        importText: "pkg",
        startLine: 1,
        importedNames: ["sub"],
        importedBindings: { sub: "sub" },
      },
    ],
    table,
  );
  expect(strategy().attempt(call("sub", "helper"), ctx)).toEqual({
    kind: "continue",
  });
});

it("CONTINUEs when the composed module text names no file", () => {
  const table = tableWith({
    "domains/identity/models.py": ["User"],
    "domains/identity/services.py": ["login"],
  });
  const ctx = ctxWith(
    "domains/identity/services.py",
    [
      {
        importText: "domains",
        startLine: 1,
        importedNames: ["identity"],
        importedBindings: { identity: "identity" },
      },
    ],
    table,
  );
  expect(strategy().attempt(call("identity", "User"), ctx)).toEqual({
    kind: "continue",
  });
});
```

- [ ] GREEN — widen the imports at the top of `python-imported-name.ts`. Add
      `type SymbolResolutionTarget` to the existing
      `contracts/types/codegraph.js` import list and add one new import line,
      kept in the file's existing alphabetical order (`vocabulary/` sorts before
      `../python-import-file-mapper.js`):

```ts
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
```

- [ ] GREEN — add the single-hop constant just above the class, with the two
      module-level helpers going at the BOTTOM of the file next to `findBinding`
      and `packageScopeOf` (module-level functions are grouped there already):

```ts
/**
 * A receiver this pass will answer: exactly ONE identifier. `Event.id.label()`,
 * `Job.objects.filter(…).delete()` and `Cls().method()` all reach here with a
 * receiver the old head-only `split(".")[0]` reduced to `Event` / `Job` / `Cls`
 * — dropping the middle hops and pinning a member the head never declared. Six
 * netbox rows and five polar rows were fabricated exactly that way, every one a
 * `phantom`. Folding hop by hop is `chainType`'s job; an import statement is
 * evidence about ONE name.
 */
const SINGLE_HOP_RECEIVER = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

```ts
/**
 * Is this an ABSOLUTE import of a stdlib module? Relative text (`.models`) can
 * never name the stdlib and its first segment is empty, so it is excluded
 * rather than tested.
 */
function importsStdlibModule(importText: string): boolean {
  if (importText.startsWith(".")) return false;
  return PYTHON_STDLIB_MODULES.has(importText.split(".")[0]);
}

/**
 * The module text a single-identifier receiver denotes, from the two shapes
 * `collectPythonImports` records (`walker/walker.ts:499`).
 *
 * `importedBindings[local] === importText` IS the `import_statement` form —
 * there the recorded value is the MODULE PATH. An unaliased `import a.b` binds
 * the top package, so its head denotes `a`, not `a.b`; an aliased one denotes
 * the whole path. Everything else is `from M import name`, where the value is
 * an exported NAME and the receiver denotes the SUBMODULE `M.name` — joined
 * without a separator when `M` already ends in a dot, or `from . import c`
 * would compose `..c` and climb a package.
 */
function receiverModuleText(binding: ImportBinding): string {
  const { importText } = binding.imp;
  if (binding.importedName === importText) {
    const firstSegment = binding.importedName.split(".")[0];
    return binding.localName === firstSegment
      ? firstSegment
      : binding.importedName;
  }
  return importText.endsWith(".")
    ? `${importText}${binding.importedName}`
    : `${importText}.${binding.importedName}`;
}
```

- [ ] GREEN — replace `attempt` so the guard runs before the binding lookup. The
      receiver IS the head now, so the `split` goes away with it:

```ts
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // Single hop only — see SINGLE_HOP_RECEIVER. Bare calls (`receiver: null`)
    // are unaffected, including the star-import path below.
    if (call.receiver !== null && !SINGLE_HOP_RECEIVER.test(call.receiver)) return CONTINUE;
    const localName = call.receiver ?? call.member;
    const binding = findBinding(ctx.imports, localName);
    if (binding) return this.resolveBinding(binding, call, ctx);
    return this.resolveStarImport(call, ctx);
  }
```

- [ ] GREEN — replace `resolveBinding`'s body. It now branches three ways: the
      stdlib DROP ahead of the mapper, the existing declared-name path (moved
      out to `resolveDeclaredName` unchanged), and the module fall-through.

```ts
  /**
   * The name is bound by an import. Map its module, then find the declaration:
   * in the mapped file, or — when the mapped file is a package `__init__.py`
   * that re-exports rather than declares — through one `reexportOriginFile`
   * hop, the same engine TypeScript uses for barrels. A bound name that NO
   * file declares as a symbol is a module, and its member is looked up as a
   * top-level declaration inside it.
   */
  private resolveBinding(binding: ImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    // The stdlib check stays AHEAD of the mapper, the same way
    // `PythonExternalVocabulary.importLandsInProject` keeps it (bd
    // tea-rags-mcp-mmckn): the mapper probes the caller's ancestor directories
    // first, so `import json` from `netbox/utilities/forms/fields/fields.py`
    // lands on netbox's own `netbox/utilities/json.py` and 45 stdlib calls
    // become in-project phantoms. Absolute-import semantics settle it — a
    // project module of the same name is reachable through a relative or
    // package-qualified import, never through bare `import json`.
    if (importsStdlibModule(binding.imp.importText)) return DROP;

    const mapped = this.mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "external") return DROP;
    if (mapped.kind === "project") {
      const declaringFile = this.declaringFile(binding.importedName, mapped.relPath, ctx);
      if (declaringFile) return this.resolveDeclaredName(binding, declaringFile, call, ctx);
    }
    return this.resolveModuleReceiver(binding, call, ctx);
  }
```

- [ ] GREEN — add the three new private methods directly under `resolveBinding`,
      before `declaringFile`. `resolveDeclaredName` is the old lookup block
      moved verbatim; do not change a character of its two `wanted` spellings or
      their order.

```ts
  /**
   * The bound name IS a symbol, declared in `declaringFile`. A qualified
   * receiver looks up `<importedName>.<member>` — the classmethod / staticmethod
   * spelling — then `<importedName>#<member>`, the instance one; a bare call
   * looks up the imported name itself. Python symbolIds carry no module path,
   * so every lookup is filtered to the declaring file.
   */
  private resolveDeclaredName(
    binding: ImportBinding,
    declaringFile: string,
    call: CallRef,
    ctx: CallContext,
  ): SymbolResolutionOutcome {
    const wanted = call.receiver
      ? [`${binding.importedName}.${call.member}`, `${binding.importedName}#${call.member}`]
      : [binding.importedName];
    for (const fqName of wanted) {
      const candidates = ctx.symbolTable.lookup(fqName).filter((def) => def.relPath === declaringFile);
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    }
    return CONTINUE;
  }

  /**
   * The receiver names a MODULE — `columns.ColorColumn()` under
   * `from netbox.tables import columns`, 435 of netbox's 437 `wrongFile` rows.
   *
   * The composed module text is mapped INSTEAD of the parent, not after it:
   * `from netbox import denormalized` has a parent the mapper calls `unknown`
   * (a PEP 420 namespace directory has no `__init__.py` to name), and only
   * `netbox.denormalized` resolves to a file. 52 more netbox rows are that
   * shape.
   */
  private resolveModuleReceiver(binding: ImportBinding, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE; // a bare call names no module
    const mapped = this.mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
    if (mapped.kind === "external") return DROP;
    if (mapped.kind !== "project") return CONTINUE;
    const target = this.moduleMemberTarget(call.member, mapped.relPath, ctx);
    return target ? resolved(target) : CONTINUE;
  }

  /**
   * `member` as a TOP-LEVEL declaration of `moduleFile`, or `null`.
   *
   * `lookup` is exact-symbolId, and only a top-level `def` / `class` carries
   * the bare name as its whole id — a method is `Cls#member` or `Cls.member`.
   * So this cannot reach inside a class the way `lookupByShortName` would, and
   * a module declaring the name twice yields two candidates and declines.
   */
  private moduleMemberTarget(member: string, moduleFile: string, ctx: CallContext): SymbolResolutionTarget | null {
    const candidates = ctx.symbolTable.lookup(member).filter((def) => def.relPath === moduleFile);
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }
```

- [ ] GREEN — update the class docblock. Add one paragraph after the existing
      "Three outcomes, no fourth" paragraph:

```ts
 * TWO receiver shapes, one binding table. `Device.objects` is a CLASS receiver:
 * the bound name is a symbol, and the member is `Device.objects` or
 * `Device#objects` inside the file that declares it. `columns.ColorColumn()` is
 * a MODULE receiver: no file declares `columns` as a symbol, because it is a
 * submodule, and the member is a top-level declaration of the file the composed
 * module text maps to. The receiver must be a SINGLE identifier for either —
 * a further hop is a fold, and folding is `chainType`'s pass, not this one.
```

- [ ] VERIFY — `npx vitest run tests/core/domains/language/python/resolver`
      green, all nine new cases passing and every pre-existing case in
      `python-imported-name.test.ts` untouched and still green. Then
      `npx tsc --noEmit`.

- [ ] GUARD — add one regression case asserting the pre-existing external DROP
      still fires through the new control flow (it passes immediately; it exists
      so a later edit to `resolveBinding` cannot silently lose it):

```ts
it("DROPs a receiver bound from a third-party module", () => {
  const table = tableWith({
    "app/models.py": ["Thing"],
    "app/__init__.py": ["VERSION"],
  });
  const ctx = ctxWith(
    "app/models.py",
    [
      {
        importText: "django.db",
        startLine: 1,
        importedNames: ["models"],
        importedBindings: { models: "models" },
      },
    ],
    table,
  );
  expect(strategy().attempt(call("models", "CharField"), ctx)).toEqual({
    kind: "drop",
  });
});
```

- [ ] COMMIT —
      `feat(language): resolve Python module receivers in importedName (9fgdi)`.
      Body: the 437 + 52 + 45 + 6 row counts, the single-hop rationale, and the
      stdlib-ahead-of-the-mapper precedent (bd `mmckn`).

## Task 2: one re-export hop for a module member, and the class receiver pinned

**Files**

- `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
- `tests/core/domains/language/python/resolver/strategies/python-imported-name.test.ts`

**Interfaces** — no new names. `moduleMemberTarget` keeps its Task 1 signature
and grows a second lookup.

### Steps

- [ ] RED — add the re-export case and its decline. Both fail today: the first
      returns `{ kind: "continue" }` because a package `__init__.py` declares
      nothing, the second must KEEP returning it.

```ts
it("follows one re-export hop out of a package __init__ to the declaring module", () => {
  const table = tableWith({
    "netbox/circuits/tables/circuits.py": ["CircuitTable"],
    "netbox/netbox/__init__.py": ["VERSION"],
    "netbox/netbox/tables/__init__.py": ["BaseTable"],
    "netbox/netbox/tables/columns.py": ["ColorColumn"],
  });
  const ctx = ctxWith(
    "netbox/circuits/tables/circuits.py",
    [
      {
        importText: "netbox",
        startLine: 1,
        importedNames: ["tables"],
        importedBindings: { tables: "tables" },
      },
    ],
    table,
  );
  expect(strategy().attempt(call("tables", "ColorColumn"), ctx)).toEqual({
    kind: "resolved",
    target: {
      targetRelPath: "netbox/netbox/tables/columns.py",
      targetSymbolId: "ColorColumn",
    },
  });
});

it("declines the hop when the name is declared in two files", () => {
  const table = tableWith({
    "netbox/circuits/tables/circuits.py": ["CircuitTable"],
    "netbox/netbox/__init__.py": ["VERSION"],
    "netbox/netbox/tables/__init__.py": ["BaseTable"],
    "netbox/netbox/tables/columns.py": ["ColorColumn"],
    "netbox/dcim/columns.py": ["ColorColumn"],
  });
  const ctx = ctxWith(
    "netbox/circuits/tables/circuits.py",
    [
      {
        importText: "netbox",
        startLine: 1,
        importedNames: ["tables"],
        importedBindings: { tables: "tables" },
      },
    ],
    table,
  );
  // Two declarations, and the barrel-package retry cannot separate them either
  // — `netbox/dcim/` is not under `netbox/netbox/tables/`. The existing edge
  // beats a coin flip (bd tea-rags-mcp-ex28m).
  expect(strategy().attempt(call("tables", "ColorColumn"), ctx)).toEqual({
    kind: "continue",
  });
});
```

- [ ] GREEN — replace `moduleMemberTarget`'s body with the two-step lookup:

```ts
  private moduleMemberTarget(member: string, moduleFile: string, ctx: CallContext): SymbolResolutionTarget | null {
    const direct = pickSingleCandidate(
      ctx.symbolTable.lookup(member).filter((def) => def.relPath === moduleFile),
      this.cfg.mode,
    );
    if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
    // The module re-exports rather than declares — a package `__init__.py`
    // pulling `ColorColumn` out of its own `columns.py`. ONE hop, through the
    // same engine `declaringFile` uses two methods down, so the two questions
    // cannot drift apart. Its three gates do the declining: the name must be in
    // the table, `moduleFile` must not declare it, and the declaration must be
    // unique (retried inside the package on a global tie). The target module's
    // OWN `importedBindings` are not reachable from a `CallContext` — see the
    // helper's docblock — so declaration lookup is the mechanism, and it covers
    // `from .columns import *` for free.
    const origin = reexportOriginFile(member, moduleFile, ctx, this.cfg.mode);
    if (!origin) return null;
    const hopped = pickSingleCandidate(
      ctx.symbolTable.lookup(member).filter((def) => def.relPath === origin),
      this.cfg.mode,
    );
    return hopped ? { targetRelPath: hopped.relPath, targetSymbolId: hopped.symbolId } : null;
  }
```

- [ ] PIN — add three characterization cases for the CLASS receiver. They pass
      immediately; they exist because nothing in the suite currently pins the
      SPELLING ORDER, and the module branch now sits one `if` away from it.

```ts
describe("PythonImportedNameSymbolResolutionStrategy — class receiver spellings", () => {
  const jobsTable = () =>
    tableWith({
      "netbox/core/signals.py": ["handle_sync"],
      "netbox/core/jobs.py": ["SyncDataSourceJob"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/jobs.py": [
        "JobRunner",
        "JobRunner.enqueue",
        "JobRunner#run",
        "JobRunner#get_jobs",
      ],
    });
  const jobsCtx = (
    table: ReturnType<typeof jobsTable>,
    module: string,
    bound: string,
  ) =>
    ctxWith(
      "netbox/core/signals.py",
      [
        {
          importText: module,
          startLine: 1,
          importedNames: [bound],
          importedBindings: { [bound]: bound },
        },
      ],
      table,
    );

  it("prefers the classmethod / staticmethod spelling `Cls.member`", () => {
    const table = jobsTable();
    expect(
      strategy().attempt(
        call("JobRunner", "enqueue"),
        jobsCtx(table, "netbox.jobs", "JobRunner"),
      ),
    ).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "netbox/netbox/jobs.py",
        targetSymbolId: "JobRunner.enqueue",
      },
    });
  });

  it("falls to the instance spelling `Cls#member`", () => {
    const table = jobsTable();
    expect(
      strategy().attempt(
        call("JobRunner", "run"),
        jobsCtx(table, "netbox.jobs", "JobRunner"),
      ),
    ).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "netbox/netbox/jobs.py",
        targetSymbolId: "JobRunner#run",
      },
    });
  });

  it("CONTINUEs when the member is INHERITED, leaving MRO to its own seam", () => {
    const table = jobsTable();
    // netbox's only two `missed` rows with a `constant` receiver:
    // `SyncDataSourceJob.get_jobs()` where jedi answers `JobRunner.get_jobs`.
    expect(
      strategy().attempt(
        call("SyncDataSourceJob", "get_jobs"),
        jobsCtx(table, ".jobs", "SyncDataSourceJob"),
      ),
    ).toEqual({
      kind: "continue",
    });
  });
});
```

- [ ] VERIFY — `npx vitest run tests/core/domains/language/python/resolver`
      green; `npx tsc --noEmit`.
- [ ] COMMIT —
      `feat(language): follow one re-export hop for Python module members (9fgdi)`.

## Task 3: `importMatch` CONTINUEs on a receiver an import bound

**Files**

- `src/core/domains/language/python/resolver/strategies/shared.ts`
- `src/core/domains/language/python/resolver/strategies/python-imported-name.ts`
- `src/core/domains/language/python/resolver/strategies/python-import-match.ts`
- `tests/core/domains/language/python/resolver/strategies/strategies.test.ts`

**Interfaces** — the binding lookup gets a second consumer, so it moves to
`shared.ts` under domain-qualified names (`.claude/rules/naming.md`):

```ts
export interface PythonImportBinding {
  imp: ImportRef;
  localName: string;
  importedName: string;
}
export function findPythonImportBinding(
  imports: readonly ImportRef[],
  localName: string,
): PythonImportBinding | null;
```

### Steps

- [ ] REFACTOR — move `ImportBinding` and `findBinding` out of
      `python-imported-name.ts` into `shared.ts`, renamed as above, docblocks
      carried over verbatim. `shared.ts` needs `type ImportRef` added to its
      `contracts/types/codegraph.js` import list. In `python-imported-name.ts`,
      import both from `./shared.js` (it already imports `type ResolverConfig`
      from there) and replace the three `ImportBinding` annotations and the one
      `findBinding(` call site. No behaviour change; the suite must be green on
      this step alone before the next one starts.

- [ ] RED — add two cases to the `PythonImportMatchSymbolResolutionStrategy`
      describe in `strategies.test.ts`. The first fails today (it resolves onto
      the caller's sibling); the second must stay green throughout — it is the
      residual the demotion is required NOT to touch.

```ts
it("continues when the receiver is a name an import BOUND — importedName owns it", () => {
  const symbolTable = tableWith(
    [
      "netbox/circuits/tables/columns.py",
      [
        sym(
          "ColorColumn",
          "ColorColumn",
          "netbox/circuits/tables/columns.py",
          [],
        ),
      ],
    ],
    [
      "netbox/netbox/tables/columns.py",
      [
        sym(
          "ColorColumn",
          "ColorColumn",
          "netbox/netbox/tables/columns.py",
          [],
        ),
      ],
    ],
  );
  const outcome = strat.attempt(
    {
      callText: "columns.ColorColumn()",
      receiver: "columns",
      member: "ColorColumn",
      startLine: 1,
    },
    ctx({
      symbolTable,
      callerFile: "netbox/circuits/tables/circuits.py",
      imports: [
        {
          importText: "netbox.tables",
          startLine: 1,
          importedNames: ["columns"],
          importedBindings: { columns: "columns" },
        },
      ],
    }),
  );
  // Trailing-segment matching picks the caller's own sibling, 437 times on
  // netbox. The binding pass ran first and had better evidence, whatever it
  // decided (bd tea-rags-mcp-9fgdi).
  expect(outcome.kind).toBe("continue");
});

it("still answers when the receiver is bound by NOTHING", () => {
  const symbolTable = tableWith([
    "domains/identity/models/user.py",
    [sym("User#save", "save", "domains/identity/models/user.py", ["User"])],
  ]);
  const outcome = strat.attempt(
    { callText: "user.save()", receiver: "user", member: "save", startLine: 1 },
    ctx({
      symbolTable,
      callerFile: "domains/identity/services/auth/vk_login.py",
      imports: [
        {
          importText: "domains.identity.models.user",
          startLine: 1,
          importedNames: ["User"],
          importedBindings: { User: "User" },
        },
      ],
    }),
  );
  // `user` is a local holding a User; the import bound `User`, not `user`.
  // ugnest's only two `match` rows from this pass are exactly this.
  expect(outcome).toEqual({
    kind: "resolved",
    target: {
      targetRelPath: "domains/identity/models/user.py",
      targetSymbolId: "User#save",
    },
  });
});
```

- [ ] GREEN — add the early CONTINUE to
      `PythonImportMatchSymbolResolutionStrategy.attempt`, directly after the
      existing `if (!call.receiver) return CONTINUE;`:

```ts
// Demoted on a receiver an import BOUND (bd tea-rags-mcp-9fgdi).
// `importedName` runs one pass earlier and READS the binding table; this
// pass GUESSES from a module's trailing segment, and on netbox that guess
// is wrong every single time it fires on this shape — 437 `wrongFile` plus
// 45 stdlib `phantom` out of 517 answers, and not one `match`. What is left
// is receivers nothing bound: star imports, a module-path segment that
// merely looks like the receiver, dynamic attributes — 35 rows on netbox.
// Whole receiver, not its head: `pythonImportMatchesReceiver` compares a
// single module segment against the entire receiver text, so a dotted
// receiver never reaches the answer path anyway.
if (findPythonImportBinding(ctx.imports, receiver) !== null) return CONTINUE;
```

      and extend its import from `./shared.js` with `findPythonImportBinding`.

- [ ] GREEN — replace the docblock's "On miss … never a drop" sentence with the
      demotion, and keep the whole `86qfb` file-only-edge paragraph as it
      stands: that measurement is about parking versus committing, which this
      change does not touch.

- [ ] AUDIT — read every case in the `PythonImportMatchSymbolResolutionStrategy`
      describe and confirm none needs editing. As of `f13779956` all four use
      `imports: [{ importText: "foo", startLine: 1 }]` with neither
      `importedNames` nor `importedBindings` — the walker-1 shape, which binds
      nothing, so the demotion cannot fire on them. If a parallel session has
      added a case whose fixture DOES carry a binding for the receiver, change
      only that assertion and only with an inline comment naming bd
      `tea-rags-mcp-9fgdi` and the reason (`.claude/rules/test-invariants.md`).

- [ ] VERIFY — `npx vitest run tests/core/domains/language/python` green;
      `npx tsc --noEmit`. The two offline harnesses need NO edit: both call
      `createPythonSymbolResolutionChain`, and the chain is unchanged.
- [ ] COMMIT —
      `feat(language): demote Python importMatch on bound receivers (9fgdi)`.

## Task 4: gates, and the two facts the navigator has to carry

**Files**

- `src/core/domains/language/python/CLAUDE.md`
- no source changes; this task measures and documents

### Steps

- [ ] BEFORE — from a checkout pinned at this seam's PARENT commit (the base
      Task 1 branched from), dump all four deterministic corpora. `$BASE` is
      that checkout's root, `$OUT` a scratch directory outside the repo.

```bash
for c in netbox flask httpx ugnest; do
  ORACLE_MODULE=$BASE/scripts/py-codegraph-jedi-oracle.ts DUMP_OUT=$OUT/before-$c.ndjson \
    npx tsx /Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/dump-rows.mts --corpus $c --quiet
done
```

- [ ] AFTER — same four, `ORACLE_MODULE` pointing at the Task 3 tip, into
      `$OUT/after-<c>.ndjson`. Then diff each:

```bash
for c in netbox flask httpx ugnest; do
  echo "== $c"
  node /Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/diff-rows.mjs \
    $OUT/before-$c.ndjson $OUT/after-$c.ndjson summary
done
```

- [ ] GATE — read the summaries against these thresholds, and report per corpus,
      never as a headline (measurement policy):
  - gross `lost` **0** on all four. A `match` that became anything else is a
    hard stop, not a trade.
  - netbox `wrongFile` down by ~437 and `phantom` down by ~51 (45 stdlib module
    receivers + 6 dotted-receiver rows). `match` up on `receiverKind: dynamic` —
    module receivers classify as `dynamic`, not `constant`, so a flat `constant`
    row is expected and correct.
  - flask / httpx / ugnest: no regression. Their `importMatch` output is tiny
    (flask 4 `chainOnly` + 5 `phantom` + 2 `wrongFile`, httpx 2 + 1 + 0, ugnest
    2 `match`), and ugnest's two matches must SURVIVE — they are the unbound
    `user.save()` shape decision 9 protects.
  - polar: dump it, quote its per-verdict tally, and draw no conclusion. Its
    oracle is non-deterministic while three `polar` packages are importable and
    the host child does not pin `PYTHONHASHSEED=0` (E0.11 owns that fix).
- [ ] GATE — chain drift, five consecutive runs, `chainDrift 0` every time:

```bash
# `--corpus` here is an absolute PATH (`resolvePath`), NOT a manifest name —
# unlike the oracle's `--corpus`, which accepts either. Same flag, two contracts.
NB=~/Dev/Tools/tea-rags-bench/corpora/netbox
for i in 1 2 3 4 5; do npx tsx scripts/codegraph-chain-tally.ts --lang python --corpus $NB | rg chainDrift; done
```

- [ ] GATE — perf A/B on netbox: wall ≤ +25%, peak RSS ≤ +20% against the same
      BEFORE checkout, measured on the tally run (it walks the corpus and
      resolves without the oracle's subprocess in the way). The added work is
      one extra `mapImportToFile` per module receiver — memoised per
      `<dir> <moduleText>` — and one `Map` lookup; a number outside the budget
      means something is allocating per call site, not that the budget is tight.
- [ ] GATE — `npm run test:coverage`, exit 0. This is the gate, not `npm test`
      (`.claude/rules/epic-completion-gate.md`).
- [ ] DOC — extend the EXISTING navigator bullet in
      `src/core/domains/language/python/CLAUDE.md`, "The vocabulary's stdlib
      check runs BEFORE the mapper", to name its second implementation site:
      `PythonImportedNameSymbolResolutionStrategy.resolveBinding` DROPs on an
      absolute stdlib `importText` for the same reason and with the same
      measured cause (the ancestor scan reaching `netbox/utilities/json.py`). Do
      NOT add a third bullet repeating it — the navigator contract is one fact,
      one place.
- [ ] DOC — add two bullets to the same Resolver section:
  - **`importedName` answers TWO receiver shapes, and only SINGLE-HOP ones.** A
    class receiver (`Device.objects`) resolves through the symbol the binding
    names; a module receiver (`columns.ColorColumn()`) resolves through the
    module text the binding composes — the `import_statement` form records a
    MODULE PATH in `importedBindings`, the `from` form an exported NAME, and
    `importedBindings[local] === importText` is the discriminator. The composed
    text is mapped INSTEAD of the parent package, because a PEP 420 namespace
    parent maps to `unknown`. A receiver with a further hop CONTINUEs: folding
    belongs to `chainType`.
  - **`importMatch` only answers receivers nothing bound.** Its trailing-segment
    heuristic is measured wrong on every import-bound receiver it fires on
    (netbox: 517 answers, 0 `match`), so it CONTINUEs when
    `findPythonImportBinding` finds the receiver. What is left is star imports,
    module-path segments that merely look like the receiver, and dynamic
    attributes — 35 rows on netbox after this seam. Whether that residual earns
    the pass is the next seam's question, not a symmetry argument.
- [ ] BEAD — record in `9fgdi`: the four per-corpus diff summaries, the measured
      `importMatch` residual after the demotion (count and verdict split per
      corpus), and the polar tally marked informational. The residual is the
      input the removal decision needs.
- [ ] COMMIT —
      `docs(language): record Python imported-receiver seam results (9fgdi)`.

## Decision-to-task map

| Decision                                          | Task |
| ------------------------------------------------- | ---- |
| 1 `importMatch` is pure damage on netbox          | 3    |
| 2 module receiver hangs off `declaringFile`       | 1    |
| 3 two `importedBindings` shapes, two compositions | 1    |
| 4 single-hop only                                 | 1    |
| 5 stdlib ahead of the mapper                      | 1    |
| 6 four decline rules                              | 1, 2 |
| 7 re-export hop reuses `reexportOriginFile`       | 2    |
| 8 class receiver pinned, not changed              | 2    |
| 9 `importMatch` demoted, residual recorded        | 3, 4 |
| 10 gates                                          | 4    |

## Follow-up beads to file

- **Move the stdlib-ahead-of-the-mapper check INTO the mapper.** Three call
  sites now carry the same guard (`PythonExternalVocabulary`, this pass, and
  whatever comes next). The mapper consults `PYTHON_STDLIB_MODULES` only as a
  residual, after the ancestor scan; hoisting it would fix every consumer at
  once, but it changes `resolveTypeFile`, `importMatch`, `localBinding` and
  `chainType` in one move and belongs to a mapper seam with its own A/B.
- **The inheritance half of the class receiver.** netbox's two `missed`
  `constant` rows are `Cls.member()` where `member` lives on a base
  (`JobRunner.get_jobs`). `walkClassExtendsForMethod` in `strategies/shared.ts`
  already does that walk for other passes; wiring it here is an MRO-seam
  decision, not this one's.
- **Attribute a namespace-package import to its member files.** Already noted in
  the mapper's `probePath` docblock; the `domains/identity` CONTINUE in Task 1
  is a live example of what it costs.
- **Re-measure whether `importMatch` earns its slot at all**, from the residual
  Task 4 records.

## Gate record (Task 4, measured)

BEFORE is the pre-seam tree `agent-a9eb6ca5c3a2402f3` (E2.3d landed, IR.1–IR.3
absent), AFTER is `agent-a9056415c636db6de`. Rows keyed by
`(relPath, startLine, callText)`; polar's BEFORE dump is the seeded per-file
rooted run at `jobs/dffe3647/tmp/e23d/polar.ndjson`.

| Corpus | match           | missed      | wrongFile    | phantom       | agreeExternal |
| ------ | --------------- | ----------- | ------------ | ------------- | ------------- |
| netbox | 9064 → **9551** | 1785 → 1733 | 499 → **64** | 612 → **652** | 38951 → 38908 |
| flask  | 509 → 509       | 162 → 162   | 11 → 11      | 104 → **101** | 1182 → 1185   |
| httpx  | 690 → 690       | 192 → 192   | 0 → 0        | 80 → 80       | 1404 → 1405   |
| ugnest | 1370 → **1374** | 85 → 81     | 0 → 0        | 377 → **386** | 4884 → 4875   |
| polar¹ | 16457 → 16507   | 9865 → 9857 | 111 → 77     | 1825 → 1670   | 40575 → 40730 |

¹ informational only — non-deterministic oracle (E0.11).

Row-level: gross `lost` **0** on all four deterministic corpora. Gained 487
(netbox), 4 (ugnest), 0 (flask, httpx). Polar shows gross lost 34 (31
`importMatch`, 3 `importedName`, all → `missed`) against 84 gained; no
conclusion drawn.

**PASS.** `lost` 0; netbox `wrongFile` −435, exactly the predicted 437-row
population less the 2 that were never `importMatch`'s; `match` +487, every one
on a `dynamic` receiver.

**FAIL — `phantom` is UP, not down: netbox +40, ugnest +9, flask +2.** The
predicted wins all landed (netbox: 45 stdlib `importMatch` phantoms and 6
dotted-receiver `importedName` phantoms went to `agreeExternal`, plus 4 from
`globalShortName`), but 95 NEW netbox phantoms appeared, all
`agreeExternal → phantom/globalShortName`, all on dotted receivers (81
`ContentType.objects`, 7 `os.*`, 4 `mptt.*`, 2 `sys.*`, 1 `django.*`). Cause:
`SINGLE_HOP_RECEIVER` gates the top of `attempt`, ahead of the binding lookup,
so a dotted receiver whose head an import bound no longer reaches
`resolveBinding`'s `external` → DROP. It falls to `globalShortName`, which pins
on short name alone. Decision 4 counted only rows `importedName` ANSWERED with a
dotted receiver (6 on netbox); it did not count the rows it DROPPED. Same shape
on ugnest (`Group.objects.get`, `base64.…().decode`) and flask
(`werkzeug.utils.send_file`). Fix candidate for a follow-up: run the guard AFTER
the binding lookup and the mapper's `external` verdict, so the DROP survives and
only the resolution is skipped.

`importMatch` residual after the demotion — the input the removal decision
needs:

| Corpus | before | after | after split                                          |
| ------ | -----: | ----: | ---------------------------------------------------- |
| netbox |    517 |    35 | 18 chainOnly, 15 phantom, 2 wrongFile                |
| flask  |     11 |     6 | 4 chainOnly, 2 wrongFile                             |
| httpx  |      0 |     0 | —                                                    |
| ugnest |      2 |     2 | 2 match (the unbound `user.save()` shape — SURVIVED) |
| polar¹ |    433 |    60 | 29 phantom, 20 chainOnly, 9 match, 2 wrongFile       |

Not one `match` was lost to the demotion on the four deterministic corpora, and
outside ugnest's two rows the pass produces no `match` at all. Polar is where
the cost sits: 71 → 9 matches. Removal is a polar-gated decision.

Chain drift: netbox ×5 consecutive `chain drift vs production resolver: 0`; one
run each on polar / httpx / flask / ugnest, all 0; every oracle walk in the A/B
reported `chainDrift 0` as well.

Perf, netbox chain-tally, interleaved B/A/A/B under `/usr/bin/time -l` with
`NODE_OPTIONS=--max-old-space-size=1024`, min of 2 per side: wall 13.99s →
13.19s (**−5.7%**, budget +25%); peak RSS 2.304 GB → 2.455 GB (**+6.6%**, budget
+20%). Both inside budget.

`npm run test:coverage`: exit 0 — statements 96.32, branches 88.82, functions
97.38, lines 98.40; 851 test files, 12414 passed, 1 skipped.
