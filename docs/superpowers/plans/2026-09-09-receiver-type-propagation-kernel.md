# Receiver Type-Propagation Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the language-neutral half of Ruby's receiver type-propagation
engine — the dotted-chain fold — into
`src/core/domains/language/kernel/receiver-type-propagation.ts`, parameterized
by a stateless `ReceiverTypePorts`. Ruby's `resolver/type-propagation.ts` keeps
every exported name it has today and becomes the file that supplies the Ruby
ports, so all 8 Ruby importers and every Ruby test are untouched. Python then
supplies its own ports and gains one new chain pass,
`PythonChainTypeSymbolResolutionStrategy` (`chainType`), which is what finally
reads the `structuredReturnTypes` the annotation facet
(`2026-09-09-python-annotation-type-facet.md`) started emitting into a channel
with no reader. This is E1 seam 3 + its E2 consumer.

**Architecture:** Relocation, not redesign. The kernel gains one file exporting
`propagateReceiverType(receiver, atLine, ctx, ports)` and the
`ReceiverTypePorts` interface with FOUR ports — `singleHopType`, `seedHead`,
`memberTypeOf`, `maxHops`. Everything Ruby-shaped stays in `ruby/`: the `@ivar`
channel, the nullary self-call fallback, the typed-container index access, the
`CONST_HEAD` / gem-vocabulary head seeding, the `CODEGRAPH_RB_CHAIN_MAX_HOPS`
env name. Python's ports are net-new and read three channels it already has —
`localBindings`, `classFieldTypes`, `structuredReturnTypes`. Ports are
STATELESS module-level singletons taking `ctx` as their last argument, so the
engine allocates nothing per call site.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. New code in `src/core/domains/language/kernel/`,
`src/core/domains/language/python/resolver/`, and one new spike harness under
`scripts/spikes/`.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
(E1 relocation protocol; the `propagateChain` row of the E1 epic; pull-order
item 3 — annotations are the largest recall lever and this seam is what spends
them) — plus the Decision record below.

## Decision record

### E1 seam 3 — receiver type propagation + Python `chainType` (`9fgdi`)

**1. The neutral cut is the CHAIN FOLD and nothing else.** Read
`ruby/resolver/type-propagation.ts` end to end and only three things in it are
free of Ruby: `stripArgs` (drop a trailing `(…)` from a segment), the hop cap
constant, and `resolveChain`'s left-to-right threading with STOP-at-unknown.
Everything else names Ruby by construction — `IVAR_RECEIVER` (`/^@\w+$/`),
`CONST_HEAD` (`::` scoping plus the capitalized-constant convention),
`nullaryReceiverType` (Ruby has no implicit local declaration, so an unbound
lowercase identifier IS a zero-arg self-call — false in Python, where an unbound
name is a `NameError`), `ivarTypeName`'s `callerScope.join("::")` key,
`catalogueForGemfile(ctx.gemfileContent)`, and the `CODEGRAPH_RB_` env prefix.
The engine that moves is therefore ~50 lines, which matches what the program
spec's E1 table calls `propagateChain` rather than "the propagation engine".

**2. Four ports, every one of them read off the Ruby code.**

| Port | Ruby body it holds | Python body it gets |
| --- | --- | --- |
| `singleHopType(receiver, atLine, ctx)` | `receiverTypeRef` minus the dot branch: typed-container index access, `@ivar`, local binding, `nullaryReceiverType` | `self` → enclosing class, `Cls(…)` constructor call, plain local binding |
| `seedHead(head, firstLink, ctx)` | the `CONST_HEAD` branch: `declaredReturnType` first, then the gem catalogue's `instanceReturning` verbs; both consume the first member | module-qualified constructor: `mod.Cls()` where an import maps `mod` to a file defining `Cls` |
| `memberTypeOf(recv, member, ctx)` | `returnTypeOf` — the five-channel authority, untouched | `classFieldTypes` for an attribute, `structuredReturnTypes` for a call |
| `maxHops()` | `chainMaxHops()` reading `CODEGRAPH_RB_CHAIN_MAX_HOPS` | `CODEGRAPH_PY_CHAIN_MAX_HOPS`, same default 4 |

No port exists that only one language can fill. `bindingAt` was considered and
REJECTED as a separate port: both languages reach `localBindings` through
`resolveLocalBinding`, but Ruby's reconstruction (`typeRef ?? {form: valueKind
=== "class" ? "class" : "instance", name: type}`) is Ruby's own rule about a
`var = CONST` binding, and Python has no `valueKind` at all. Folding it into
`singleHopType` keeps the reconstruction byte-identical where it belongs and
drops a port that would have had two different bodies anyway.

**3. Ports are stateless singletons; `ctx` is an argument, not a closure.**
`RUBY_RECEIVER_TYPE_PORTS` and `PYTHON_RECEIVER_TYPE_PORTS` are module-level
frozen objects. The alternative — a `rubyPortsFor(ctx)` factory closing over the
context — allocates one object and four closures per call site, and Ruby
resolves six figures of them per corpus run. The perf budget in decision 6 is
`wall ≤ +25%`; an allocation storm is the one way a pass this small could spend
it. Every port therefore takes `ctx: CallContext` last, and the engine's own
signature is `propagateReceiverType(receiver, atLine, ctx, ports)`.

**4. `--lang ruby` does not exist, so the Ruby parity gate is a cross-checkout
row diff.** The orchestrator brief and the seam-2 plan both assume
`scripts/codegraph-chain-tally.ts --lang ruby` works. It does not:
`CHAINS` holds `python` and `java` only (`codegraph-chain-tally.ts:99`,
`:104`), and `run()` throws `no chain spec for language 'ruby'` on anything
else. Adding one would mean rebuilding Ruby's 20-pass chain by hand from
`RubyCallResolver`'s inline constructor array (`ruby-resolver.ts:108`) — the
exact hand-copy hazard `3yxmy` removed for Python — and it still would not give
a BEFORE, because the tally's A/B is `--defer`, a within-process pass swap, not
a cross-commit comparison.

So Task 2 is MANDATORY, not the optional extra the brief hedged on:
`scripts/spikes/ruby-resolver-parity.ts`, the resolver analogue of
`scripts/spikes/ruby-walker-composition-parity.ts`. It builds ONE symbol table
and ONE `CallContext` per chunk, then asks TWO `RubyCallResolver` instances the
same question at every call site — the current tree's, and one dynamically
imported from `--before-root`, a sibling `git worktree` pinned at this seam's
parent commit. A row differs when `(targetRelPath, targetSymbolId)` differs.
Gate: `mismatches 0` on mastodon.

This is strictly stronger than the triple the brief asked for. `edges` /
`fileOnly` / `unresolved` are counts: a relocation that moved 40 sites off one
target and onto another scores identically. A row diff cannot. It also removes
the "which commit is BEFORE" question entirely — there is no earlier run to
compare against, both answers come from one process over one corpus walk, so
the E0.8 walk change (`26ed987f3`, which rewrote 211 lines of the tally's
corpus walk and is why main's tally and this branch's tally are not comparable)
is irrelevant to it.

**5. Python's `chainType` is terminal on both a hit and a known-external
miss.** Verdicts, mirroring `RubyChainTypeSymbolResolutionStrategy` and the
precision discipline `PythonLocalBindingSymbolResolutionStrategy` already
enforces:

- `CONTINUE` — the fold produced nothing, or produced a `union` / `container`
  form with no single class to look up. Later passes see the call exactly as
  they do today.
- `resolved(target)` — the folded type resolved to exactly one in-project
  symbol for the member, directly or through the `classExtends` walk.
- `DROP` — the folded type is known and is NOT in the project (builtin,
  stdlib, third-party): `resolveTypeFile` returns `null`. Falling through would
  hand the call to `importMatch` / `globalShortName`, the two passes that
  produce 9,892 of the E0 baseline's 12,869 phantoms.

The file-only fallback `PythonLocalBindingSymbolResolutionStrategy` uses — a
target whose `targetSymbolId` is `null` when the class's file is known but the
member is inherited from outside the project — is NOT copied here. That
fallback has measured support for a DIRECT local binding (bd `86qfb`, 68
false positives when parked); a type arrived at by folding two or three hops
has no such measurement, and this program is precision-gated. `chainType` that
knows the file but not the member returns `DROP`, and the oracle A/B in
decision 6 is what would overturn that: if `lost` is non-zero and concentrated
on this shape, the file-only fallback is the fix.

**6. Gates.** Ruby: `scripts/spikes/ruby-resolver-parity.ts` on mastodon with
`mismatches 0` and `drift 0`; `npx vitest run tests/core/domains/language/ruby`
with the SAME file and test counts as before Task 1, and
`git diff --stat -- tests/core/domains/language/ruby` empty. Python: the
row-level oracle A/B (invocation in "Context the implementer needs") over all
five corpora with gross `lost` 0, `phantom` not up, `annotationReturn` `missed`
down, `match` up; `codegraph-chain-tally.ts --lang python` ×5 corpora with
`chainDrift 0`; a same-machine perf A/B on netbox at `wall ≤ +25%`,
`RSS ≤ +20%`. Both: `npm run type-check`, `npx eslint --max-warnings 0` over
touched files, `npm run test:coverage` exit 0.

**7. The harnesses cannot see this pass until they thread the channel.** Both
`codegraph-chain-tally.ts:265` and `py-codegraph-jedi-oracle.ts:179` build a
`CallContext` with `classFieldTypes`, `localBindings`, `classExtends` and
nothing else. `structuredReturnTypes` is absent, so a `chainType` reading it
would answer `undefined` at every site in both harnesses and every gate in
decision 6 would measure a no-op while reporting green. Task 4 threads the
run-global merge of `structuredReturnTypes` (and `functionReturnTypes` /
`classAncestors`, which the same pass-1 barrier carries in production) into
both, mirroring how `classExtends` is already accumulated across files. That
edit is a prerequisite of the Python gates, not a follow-up.

---

## Global Constraints

- **No Ruby test edits, at all.**
  `git diff --stat -- tests/core/domains/language/ruby` must be EMPTY after
  every task, and `npx vitest run tests/core/domains/language/ruby` must report
  the same file count and the same passing count as it did before Task 1.
  Record both numbers before touching anything. A failing Ruby test means the
  Ruby ports are wrong — fix the ports, never the test
  (`.claude/rules/resolver-architecture.md` §4,
  `.claude/rules/test-invariants.md`).
- **`ruby/resolver/type-propagation.ts` is a risk file: relocation only.**
  fanIn 10, transitiveImpact 50. Its eight importers
  (`ruby-convention-receiver`, `ruby-dynamic-fanout-gates`, `ruby-ivar-field`,
  `ruby-return-type-binding`, `ruby-chain-type`, `ruby-union-dispatch`,
  `ruby-external-vocabulary`, `template-redirect`, plus
  `walker/type-sources/ast-inference` and
  `tests/.../type-propagation-union.test.ts`) each keep their import line
  byte-identical. Every export it has today — `typeOfReceiver`, `ivarTypeName`,
  `CHAIN_MAX_HOPS_DEFAULT`, and the five re-exports `boundCallReturnType`,
  `conventionReceiverType`, `returnTypeOf`,
  `CONTAINER_ELEMENT_RETURNING_METHODS`, `CONTAINER_BLOCK_ITERATION_METHODS` —
  survives with the same name and the same signature. No incidental
  improvements ride along.
- **Bodies move byte-identically or the cut moves.** Where a Ruby function
  mixes neutral and Ruby-specific logic, split at the smallest seam that keeps
  the neutral body character-for-character what it was, and write down the cut.
  Task 1 lists all four cuts; there are no others.
- **The kernel never names a language.**
  `kernel/receiver-type-propagation.ts` may import from `contracts/` and from
  `kernel/type-ref.js`. An import from `domains/language/<lang>/` is a
  review-stopping defect. No `@`, no `::`, no `self`, no gem catalogue, no
  `CODEGRAPH_RB_` / `CODEGRAPH_PY_` string in it.
- **No allocation per call site.** The engine takes a ports OBJECT that is a
  module-level singleton; it must not build one, and must not close over `ctx`.
  The fold is O(chain length) with an O(1) lookup per hop. No array `.map` /
  `.filter` over the whole chain, no regex compiled inside a loop.
- **`chainType` is inserted, never reordered.** The one edit to
  `createPythonSymbolResolutionChain` adds a line between `localBinding` and
  `importedName`. The other six entries keep their positions and their
  arguments. Both harnesses call that factory, so the insertion propagates to
  the tally and the oracle without a second edit — that is the whole point of
  `3yxmy`, do not reintroduce a hand-copied list.
- **A `Map` / `Set` never enters a `FileExtraction` or a `CallContext` value.**
  Both cross the NDJSON spill and serialise to `{}`
  (`contracts/types/codegraph-extraction.ts:8-11`). Maps are fine as locals.
- **Read the whole file before editing it.** `type-propagation.ts` is 265 lines
  and every one of its branches has a bead behind it. Read it in slices; do not
  edit from a search hit.

---

## File Structure

**Created**

| File | Single responsibility |
| --- | --- |
| `src/core/domains/language/kernel/receiver-type-propagation.ts` | `ReceiverTypePorts` + `propagateReceiverType` — the dotted-chain fold, hop cap, STOP-at-unknown, receiver-form collapse. |
| `src/core/domains/language/python/resolver/python-receiver-type-ports.ts` | `PYTHON_RECEIVER_TYPE_PORTS` — Python's four port bodies over `localBindings` / `classFieldTypes` / `structuredReturnTypes`. |
| `src/core/domains/language/python/resolver/strategies/python-chain-type.ts` | `PythonChainTypeSymbolResolutionStrategy` — the `chainType` pass. |
| `scripts/spikes/ruby-resolver-parity.ts` | Cross-checkout Ruby resolver row diff (`--before-root`). |
| `tests/core/domains/language/kernel/receiver-type-propagation.test.ts` | Fold semantics with hand-built ports: hop cap, STOP-at-unknown, seed consumption, collapse. |
| `tests/core/domains/language/python/resolver/strategies/python-chain-type.test.ts` | Exact `targetSymbolId` assertions, external/builtin DROP guards, position-aware binding. |

**Modified**

| File | Change |
| --- | --- |
| `src/core/domains/language/ruby/resolver/type-propagation.ts` | `resolveChain` / `receiverTypeRef` bodies become `RUBY_RECEIVER_TYPE_PORTS`; `typeOfReceiver` delegates to the kernel. Exports unchanged. |
| `src/core/domains/language/python/resolver/python-chain-factory.ts` | One line: `chainType` between `localBinding` and `importedName`. |
| `src/core/domains/language/python/resolver/strategies/index.ts` | Export the new strategy. |
| `src/core/domains/language/python/resolver/strategies/python-local-binding.ts` | `resolveByLocalType`'s member lookup extracted to `shared.ts` so `chainType` reuses it. Behaviour unchanged. |
| `src/core/domains/language/python/resolver/strategies/shared.ts` | Gains `resolvePythonMemberOnType`. |
| `scripts/codegraph-chain-tally.ts` | `buildCallContext` threads the run-global type channels. |
| `scripts/py-codegraph-jedi-oracle.ts` | Same threading in `walkCorpus`. |
| `src/core/domains/language/CLAUDE.md` | Navigator bullet: where the fold lives, what a port owes. |
| `src/core/domains/language/ruby/CLAUDE.md` | Pointer: the fold moved, the vocabulary did not. |
| `src/core/domains/language/python/CLAUDE.md` | The `chainType` pass and the channels it reads. Created by the annotation-facet plan's Task 5; if that plan has not landed, create the stub here. |

---

## Context the implementer needs

### The Ruby engine, function by function, and what happens to each

`src/core/domains/language/ruby/resolver/type-propagation.ts`, 265 lines. Read
it in two slices (1–140, 140–265) before editing.

| Symbol | Lines | Verdict |
| --- | --- | --- |
| module docblock | 1–40 | Stays. Gains two sentences: the fold moved, the vocabulary did not. |
| `IVAR_RECEIVER` `/^@\w+$/` | ~58 | Ruby. Stays. |
| `CONST_HEAD` `/^[A-Z]\w*(?:::[A-Z]\w*)*$/` | ~61 | Ruby (`::`). Stays, used by `seedHead`. |
| `stripArgs(segment)` | ~64 | **Neutral. Moves** — the kernel needs it for every hop. |
| `CHAIN_MAX_HOPS_DEFAULT = 4` | ~74 | Value moves to the kernel; the Ruby name re-exports it (it is exported today). |
| `chainMaxHops()` | ~80 | Ruby (`CODEGRAPH_RB_CHAIN_MAX_HOPS`). Stays, becomes the `maxHops` port. |
| `typeOfReceiver(receiver, atLine, ctx)` | ~110 | Signature stays; body becomes one delegation line. |
| `receiverTypeRef` | ~115–170 | **CUT 1** — the `receiver.includes(".")` guard moves to the kernel; the remaining branches become `singleHopType` verbatim. |
| `resolveChain` | ~180–240 | **CUT 2** — the const-head seeding block becomes `seedHead`; the rest is the kernel fold. |
| `ivarTypeName(ivar, ctx)` | ~250 | Ruby. Stays exported (two importers). |
| `resolveIvarType` | ~262 | Ruby. Stays private. |
| five re-export lines | 50–57 | Untouched. |

**CUT 1** — `receiverTypeRef`'s first three lines are the chain guard:

```ts
if (receiver.includes(".")) {
  return resolveChain(receiver, atLine, ctx);
}
```

They move to the kernel's private `receiverTypeRefOf`. Everything after them —
the index-access block, the `@ivar` block, the local-binding block with its
`nullaryReceiverType` fallback and the `typeRef ?? { form: valueKind === … }`
reconstruction — becomes the body of `RUBY_RECEIVER_TYPE_PORTS.singleHopType`,
character-for-character, with `function receiverTypeRef(receiver, atLine, ctx)`
becoming `singleHopType(receiver, atLine, ctx)`. Same parameter order, same
returns.

**CUT 2** — inside `resolveChain`, this block and only this block becomes
`seedHead`:

```ts
const declaredHead =
  headMember !== null && CONST_HEAD.test(head) ? declaredReturnType(head, headMember, ctx) : undefined;
if (declaredHead !== undefined) { current = declaredHead; startLink = 1; }
else if (headMember !== null && CONST_HEAD.test(head) &&
         catalogueForGemfile(ctx.gemfileContent).instanceReturning.has(headMember)) {
  current = { form: "instance", name: head };
  startLink = 1;
}
```

restated as a function returning `{ type, consumedMembers: 1 } | undefined`.
Its long comment (the DECLARED-then-VOCABULARY reasoning, bd `6zpds` / `rvw34`)
moves with it unchanged.

**CUT 3** — the `else` arm of that chain, `current = typeOfReceiver(head, atLine, ctx)`,
is the RECURSION into the receiver-form-collapsed entry point. The kernel must
recurse into `propagateReceiverType` (collapsed), NOT into `receiverTypeRefOf`
(raw). Getting this backwards changes what a nilable chain head resolves to and
the Ruby parity harness will catch it.

**CUT 4** — the collapse happens ONCE, at the outer boundary.
`typeOfReceiver` wraps `receiverTypeRef` in `rubyReceiverForm`; `resolveChain`
returns raw and each hop's `returnTypeOf` result is raw inside the loop.
`rubyReceiverForm` is already `typeRefReceiverForm` from `kernel/type-ref.ts`
(seam 2 shim, `ruby/type-ref.ts:12`), so the kernel calls it directly.
Collapsing inside the loop would silently change multi-arm chain behaviour.

### The engine's exact shape

```ts
// kernel/receiver-type-propagation.ts
export interface ReceiverTypePorts {
  singleHopType(receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined;
  seedHead(head: string, firstLink: string | undefined, ctx: CallContext):
    { type: TypeRef; consumedMembers: 0 | 1 } | undefined;
  memberTypeOf(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined;
  maxHops(): number;
}
export const CHAIN_MAX_HOPS_DEFAULT = 4;
export function stripCallArgs(segment: string): string;
export function propagateReceiverType(
  receiver: string, atLine: number, ctx: CallContext, ports: ReceiverTypePorts,
): TypeRef | undefined;
```

`stripCallArgs` is `stripArgs` renamed on the way in — `.claude/rules/naming.md`
wants an exported kernel name that reads alone, and `stripArgs` in a file about
type refs does not say what kind of args.

### The Python channels this seam reads, and their exact key spellings

All three arrive on `CallContext`; the first two exist today, the third is what
`2026-09-09-python-annotation-type-facet.md` Task 4's channel adapter emits.

| Channel | Shape | Key | Written by |
| --- | --- | --- | --- |
| `localBindings` | `Record<varName, LocalBinding[]>` | variable name; each binding carries `line` + `type` | `collectLocalBindingsForChunk` (`python/walker/walker.ts:366`) + the annotation facet's `param` / `local` facts |
| `classFieldTypes` | `Record<className, Record<attr, typeName>>` | class SHORT name, attribute bare (no `@`) | `collectPythonClassFieldTypes` (`walker.ts:201`) + the facet's `ivar` facts re-keyed |
| `structuredReturnTypes` | `Record<calleeSymbolId, TypeRef>` | the callee's symbolId: `run` for a module-level def, `Cls#run` for an instance method, `Cls.run` for a `@classmethod` / `@staticmethod`, `Outer.Inner#run` for a nested class | the facet's `return` facts (annotation plan decision 5) |

`structuredReturnTypes` is keyed by symbolId as `DefaultSymbolIdComposer`
composes it with `pythonKernel.scopeSeparator === "."` (`python/kernel.ts:41`).
So `memberTypeOf({form:"instance", name:"Repo"}, "get")` looks up `Repo#get`,
and on a `class` form it looks up `Repo.get` first. Nested owners arrive
already joined with `.` — do not re-join, and never use Ruby's `::`.

`LocalBinding` has no `valueKind` on the Python side, so a Python binding is
always `{ form: "instance", name: binding.type }`. `resolveLocalBinding` /
`resolveLocalBindingType` (`contracts/types/codegraph-local-binding.ts:57`,
`:71`) are the position-aware lookups — greatest `line <= atLine`. Use them;
never index `localBindings[name][0]`.

### What a Python receiver string actually looks like

`collectPythonCalls` (`python/walker/walker.ts:598`) sets
`receiver = fn.childForFieldName("object").text` for an `attribute` callee. So
the receiver is the FULL text left of the final dot, call parens included:

| Source | `receiver` | `member` |
| --- | --- | --- |
| `x.run()` | `x` | `run` |
| `svc.build().run()` | `svc.build()` | `run` |
| `self.repo.get(id).save()` | `self.repo.get(id)` | `save` |
| `Cls().run()` | `Cls()` | `run` |
| `mod.Cls().run()` | `mod.Cls()` | `run` |
| `items[0].run()` | `items[0]` | `run` |

`stripCallArgs` is what makes `build()` → `build` and `get(id)` → `get`. An
argument list containing a dot (`svc.get(a.b).run()`) splits wrong — the fold
sees `svc`, `get(a`, `b)`. That is pre-existing in Ruby and out of scope; the
hop simply misses and the pass CONTINUEs. Do not add a paren-aware splitter.

### Running the Python oracle A/B

The two drivers live at `/Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost/`.
`dump-rows.mts` imports the oracle module named by `$ORACLE_MODULE` and writes
one NDJSON row per call site; `diff-rows.mjs` keys BEFORE against AFTER by
`(relPath, startLine, callText)` and reports gross `lost` / `gained`.

```bash
D=/Users/artk0re/.claude/jobs/dffe3647/tmp/flask-lost
W=/Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/<this-worktree>
for c in flask ugnest httpx netbox polar; do
  ORACLE_MODULE=$W/scripts/py-codegraph-jedi-oracle.ts \
  DUMP_OUT=/tmp/e1s3-before-$c.ndjson \
    npx tsx $D/dump-rows.mts --corpus $c --quiet
done
# … apply Task 3 …  then the same loop into /tmp/e1s3-after-$c.ndjson
for c in flask ugnest httpx netbox polar; do
  echo "== $c"; node $D/diff-rows.mjs /tmp/e1s3-before-$c.ndjson /tmp/e1s3-after-$c.ndjson summary
done
```

`--corpus <name>` takes a manifest name from `scripts/lib/codegraph-corpora.json`
(`parseArgs`, `py-codegraph-jedi-oracle.ts:463`), not a path. BEFORE must be
dumped with Task 4's harness threading ALREADY applied and Task 3's strategy NOT
yet inserted — otherwise the two sides differ by two changes and the diff says
nothing. Read `lost` first: the gate is 0. `annotationReturn` is a `categories`
label (`scripts/lib/py-oracle-core.ts:37`, set when
`facts.enclosingHasReturnAnnotation`), and its `missed` count is what should
fall.

### Ruby corpus and harness precedent

Corpus: `~/Dev/Tools/tea-rags-bench/corpora/mastodon`. The walker analogue —
same `--before-root` mechanism, same dynamic import, same exit code — is
`scripts/spikes/ruby-walker-composition-parity.ts` (118 lines, read it whole).
The corpus-walk helpers the new harness needs are already exported:
`collectSourceFiles`, `buildCorpusExclusionFilter`, `extractFile`,
`buildSymbolDefs` from `scripts/ts-codegraph-typechecker-oracle.js`, and
`InMemoryGlobalSymbolTable` from
`src/core/domains/trajectory/codegraph/symbols/symbol-table.js`. Copy the
two-pass structure from `codegraph-chain-tally.ts:325-385`, not from scratch.

---

## Task 1: relocate the chain fold into the kernel, Ruby supplies the ports

**Files**

- CREATE `src/core/domains/language/kernel/receiver-type-propagation.ts`
- CREATE `tests/core/domains/language/kernel/receiver-type-propagation.test.ts`
- MODIFY `src/core/domains/language/ruby/resolver/type-propagation.ts`

**Interfaces**

Consumes:

```ts
// contracts/types/language.js
type TypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "container"; element: TypeRef }
  | { form: "union"; members: readonly TypeRef[] }
  | { form: "nil" };
// kernel/type-ref.js
function typeRefReceiverForm(ref: TypeRef | undefined): TypeRef | undefined;
// ruby/resolver/ruby-member-return-types.js
function returnTypeOf(recv: RubyTypeRef, member: string, ctx: CallContext): RubyTypeRef | undefined;
// ruby/resolver/ruby-return-facts.js
function declaredReturnType(constName: string, member: string, ctx: CallContext): RubyTypeRef | undefined;
// ruby/resolver/ruby-unbound-receiver-types.js
function nullaryReceiverType(receiver: string, ctx: CallContext): RubyTypeRef | undefined;
```

Produces:

```ts
export interface ReceiverTypePorts {
  singleHopType(receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined;
  seedHead(head: string, firstLink: string | undefined, ctx: CallContext):
    { type: TypeRef; consumedMembers: 0 | 1 } | undefined;
  memberTypeOf(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined;
  maxHops(): number;
}
export const CHAIN_MAX_HOPS_DEFAULT = 4;
export function stripCallArgs(segment: string): string;
export function propagateReceiverType(
  receiver: string, atLine: number, ctx: CallContext, ports: ReceiverTypePorts,
): TypeRef | undefined;
// ruby/resolver/type-propagation.ts — unchanged public surface
export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined;
export function ivarTypeName(ivar: string, ctx: CallContext): string | undefined;
export const CHAIN_MAX_HOPS_DEFAULT: number;
export const RUBY_RECEIVER_TYPE_PORTS: ReceiverTypePorts;
```

### Steps

- [ ] Record the Ruby baseline before touching anything:
      `npx vitest run tests/core/domains/language/ruby 2>&1 | tail -5`. Write
      the file count and the passing count into the task notes. These are the
      numbers Task 4 compares against.
- [ ] Read `src/core/domains/language/ruby/resolver/type-propagation.ts` in
      full, in two slices (1–140, 140–265). Confirm the four cuts in "Context
      the implementer needs" against the real line numbers before editing.
- [ ] Create `src/core/domains/language/kernel/receiver-type-propagation.ts`
      with the fold. `stripCallArgs` and the loop body are lifted verbatim from
      `stripArgs` and `resolveChain`:

```ts
/**
 * Receiver type propagation — the language-neutral dotted-chain fold
 * (E1 seam 3, relocated from `ruby/resolver/type-propagation.ts`).
 *
 * Given `a.b.c` in receiver position, thread a type left to right: seed the
 * head, then ask `memberTypeOf` what each link yields. The first unknown hop
 * STOPS the walk and the whole receiver is untyped — never fabricate past an
 * unknown hop, because a wrong receiver type produces a wrong edge, and a
 * missing one produces silence a later pass can still answer.
 *
 * Everything language-shaped is a PORT. What an `@ivar` is, whether a bare
 * capitalized head is a constant, which env var caps the hop count, what
 * calling a member on a type yields — all of it belongs to the language, and
 * none of it belongs here. The four ports are the entire contract; a language
 * that can fill them gets multi-hop receiver typing for free.
 *
 * Ports are STATELESS: `ctx` is threaded as an argument so each language can
 * export ONE frozen singleton, and the fold allocates nothing per call site.
 */
import type { CallContext } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";
import { typeRefReceiverForm } from "./type-ref.js";

export interface ReceiverTypePorts {
  /** The language's answer for a receiver with no dot in it. */
  singleHopType(receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined;
  /**
   * A chain head that is not itself a value — a bare constant, a module alias.
   * The link arrives RAW, parens included: whether it was a CALL is
   * load-bearing (`mod.Cls()` is an instance, `mod.Cls` is the class), so the
   * port strips its own args. `consumedMembers` says how many leading links
   * the seed accounts for: 1 when the seed IS `head.firstLink`, 0 when it
   * types `head` alone.
   */
  seedHead(head: string, firstLink: string | undefined, ctx: CallContext):
    { type: TypeRef; consumedMembers: 0 | 1 } | undefined;
  /** What calling `member` on a receiver of type `recv` yields. */
  memberTypeOf(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined;
  /** Hop cap; a chain longer than this is untyped rather than half-walked. */
  maxHops(): number;
}

/** Default maximum chain hops when a language's env override is unset. */
export const CHAIN_MAX_HOPS_DEFAULT = 4;

/** Strip a trailing call argument list from a chain segment (`new(post)` → `new`). */
export function stripCallArgs(segment: string): string {
  const paren = segment.indexOf("(");
  return paren === -1 ? segment : segment.slice(0, paren);
}
```

- [ ] Append the engine to the same file. `propagateChain` recurses into
      `propagateReceiverType` (the COLLAPSED entry), matching Ruby's
      `current = typeOfReceiver(head, atLine, ctx)` — see CUT 3:

```ts
/**
 * The static {@link TypeRef} for a receiver — single-hop or multi-hop chain.
 *
 * Every answer passes through {@link typeRefReceiverForm} exactly once, at this
 * boundary, so a NILABLE type reaches callers as the one arm a call on it can
 * actually dispatch to. Hops inside the walk stay RAW: collapsing per hop would
 * change what a multi-arm intermediate resolves to.
 */
export function propagateReceiverType(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  return typeRefReceiverForm(receiverTypeRefOf(receiver, atLine, ctx, ports));
}

/** {@link propagateReceiverType}'s lookup, before the receiver-form collapse. */
function receiverTypeRefOf(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (receiver.includes(".")) return propagateChain(receiver, atLine, ctx, ports);
  return ports.singleHopType(receiver, atLine, ctx);
}

/**
 * Thread a dotted chain receiver through the fold.
 *
 * 1. Split into `[head, link1, link2, …]`.
 * 2. Seed: `seedHead` first (a head the language can type together with its
 *    first link), else recurse into the single-hop path for `head` alone.
 * 3. For each remaining link: `t = memberTypeOf(t, link)`. First `undefined`
 *    STOPS and the whole receiver is untyped.
 * 4. A chain longer than `maxHops()` links is untyped.
 */
function propagateChain(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  const segments = receiver.split(".");
  const head = segments[0];
  if (!head) return undefined;

  const links = segments.slice(1);
  if (links.length > ports.maxHops()) return undefined;

  let current: TypeRef | undefined;
  let startLink = 0;
  const seeded = ports.seedHead(head, links[0], ctx);
  if (seeded !== undefined) {
    current = seeded.type;
    startLink = seeded.consumedMembers;
  } else {
    current = propagateReceiverType(head, atLine, ctx, ports);
  }
  if (current === undefined) return undefined;

  for (let i = startLink; i < links.length; i++) {
    current = ports.memberTypeOf(current, stripCallArgs(links[i]), ctx);
    if (current === undefined) return undefined; // STOP-at-unknown-hop
  }

  return current;
}
```

- [ ] In `ruby/resolver/type-propagation.ts`, replace the `stripArgs` function
      and the `CHAIN_MAX_HOPS_DEFAULT` const with imports, and re-export the
      const so its consumers keep working:

```ts
import {
  CHAIN_MAX_HOPS_DEFAULT,
  propagateReceiverType,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";

export { CHAIN_MAX_HOPS_DEFAULT } from "../../kernel/receiver-type-propagation.js";
```

      Drop the now-unused `rubyReceiverForm` import from `../type-ref.js` — the
      kernel applies it. Keep `chainMaxHops()` exactly as it is; it still reads
      `CODEGRAPH_RB_CHAIN_MAX_HOPS` per call so test env overrides work without
      a module reload.
- [ ] Rename `receiverTypeRef` to `rubySingleHopType`, delete its first three
      lines (the `receiver.includes(".")` guard — CUT 1), and leave every
      remaining character alone: the index-access block with its
      `/^[a-z_]\w*$/` base-var test and container unwrap, the `IVAR_RECEIVER`
      branch, the `resolveLocalBinding` lookup, the `nullaryReceiverType`
      fallback, the `binding.typeRef ?? { form: binding.valueKind === "class" ?
      "class" : "instance", name: binding.type }` reconstruction. Same
      parameter list, same order.
- [ ] Extract CUT 2 from `resolveChain` into `rubySeedHead`, then DELETE
      `resolveChain` — the kernel owns the rest of it now:

```ts
/**
 * A bare-constant chain head. Two ways the first link can be typed, declared
 * facts FIRST:
 *
 *  1. DECLARED (bd tea-rags-mcp-6zpds) — the project itself states what the
 *     member returns on that constant (`scope :without_deleted` →
 *     `container(Owner)`, a YARD `@return`, an inherited fact). Custom scopes
 *     live only here; the generic vocabulary cannot know them.
 *  2. VOCABULARY (rvw34 gap b) — a framework/Ruby instance-returning verb
 *     (`new`/`find`/`create!`…) makes the chain an instance of the constant:
 *     `PostStatusService.new` is definitionally a PostStatusService.
 *
 * Both are zero-fabrication. A bare-const head that is neither declared nor
 * vocabulary (`Config.value`) is still NOT typed.
 */
function rubySeedHead(
  head: string,
  firstLink: string | undefined,
  ctx: CallContext,
): { type: RubyTypeRef; consumedMembers: 0 | 1 } | undefined {
  if (firstLink === undefined || !CONST_HEAD.test(head)) return undefined;
  const firstMember = stripCallArgs(firstLink);
  const declared = declaredReturnType(head, firstMember, ctx);
  if (declared !== undefined) return { type: declared, consumedMembers: 1 };
  if (catalogueForGemfile(ctx.gemfileContent).instanceReturning.has(firstMember)) {
    return { type: { form: "instance", name: head }, consumedMembers: 1 };
  }
  return undefined;
}
```

      Two mechanical adaptations. Ruby's `headMember` was `string | null`; the
      port takes `string | undefined`, and the `stripArgs` call that produced it
      in `resolveChain` moves INTO the port, because the kernel now hands the
      link raw. And `CONST_HEAD.test` is evaluated once instead of twice — same
      result, same short-circuit before `catalogueForGemfile`.

- [ ] Declare the Ruby ports singleton and rewrite `typeOfReceiver` as the one
      delegation line. Keep its docblock — the `rubyReceiverForm` paragraph
      still describes what happens, it just happens in the kernel now:

```ts
/**
 * Ruby's four answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`). Frozen module-level singleton: the
 * fold threads `ctx` as an argument, so nothing is allocated per call site.
 */
export const RUBY_RECEIVER_TYPE_PORTS: ReceiverTypePorts = Object.freeze({
  singleHopType: rubySingleHopType,
  seedHead: rubySeedHead,
  memberTypeOf: (recv, member, ctx) => returnTypeOf(recv, member, ctx),
  maxHops: chainMaxHops,
});

export function typeOfReceiver(receiver: string, atLine: number, ctx: CallContext): RubyTypeRef | undefined {
  return propagateReceiverType(receiver, atLine, ctx, RUBY_RECEIVER_TYPE_PORTS);
}
```

- [ ] Confirm the export surface did not move:
      `/usr/bin/grep -n '^export' src/core/domains/language/ruby/resolver/type-propagation.ts`
      must still list `boundCallReturnType`, `CONTAINER_BLOCK_ITERATION_METHODS`,
      `CONTAINER_ELEMENT_RETURNING_METHODS`, `returnTypeOf`,
      `conventionReceiverType`, `CHAIN_MAX_HOPS_DEFAULT`, `typeOfReceiver`,
      `ivarTypeName` — plus the new `RUBY_RECEIVER_TYPE_PORTS`. Nothing removed,
      nothing renamed.
- [ ] Write `tests/core/domains/language/kernel/receiver-type-propagation.test.ts`
      against HAND-BUILT ports — the kernel test must not import anything under
      `ruby/` or `python/`. Cases, one `it` each:
      - single hop: no dot, `singleHopType` answers, result passes through
        `typeRefReceiverForm` (a `Foo|nil` union collapses to `Foo`);
      - two hops: `a.b.c` with `singleHopType("a")` seeding and `memberTypeOf`
        answering twice; assert the exact terminal ref;
      - STOP-at-unknown: `memberTypeOf` returns `undefined` on hop 2 of 3 —
        result `undefined`, and hop 3's port is never called (spy on calls);
      - hop cap: `maxHops()` of 2 against `a.b.c.d` (3 links) → `undefined`,
        and `singleHopType` is never called;
      - `seedHead` consuming 1: the walk starts at link index 1;
      - `seedHead` consuming 0: the walk starts at link index 0;
      - `seedHead` declining: the head falls through to `singleHopType`;
      - `stripCallArgs`: `new(post)` → `new`, `find` → `find`, `f(` → `f`;
      - empty head (`".foo"`) → `undefined`;
      - a `nil`-only head collapses to `undefined` rather than throwing.
- [ ] `npx vitest run tests/core/domains/language/kernel/receiver-type-propagation.test.ts`
      green, then `npx vitest run tests/core/domains/language/ruby` with the
      SAME file and passing counts recorded in step 1, and
      `git diff --stat -- tests/core/domains/language/ruby` empty.
- [ ] `npm run type-check`; `npx eslint --max-warnings 0` on the two touched
      source files and the new test.
- [ ] Commit: `refactor(language): relocate the receiver chain fold to the kernel (9fgdi)`.

---

## Task 2: cross-checkout Ruby resolver parity harness

The gate for Task 1. It exists because `codegraph-chain-tally.ts` has no Ruby
chain spec (decision 4) and because a count triple cannot see a swapped target.

**Files**

- CREATE `scripts/spikes/ruby-resolver-parity.ts`

**Interfaces**

Consumes:

```ts
// scripts/ts-codegraph-typechecker-oracle.js
function collectSourceFiles(root: string, base: string, filter: unknown, extensions: readonly string[]):
  Promise<{ kept: string[]; ingestIgnored: number; codegraphExcluded: number }>;
function buildCorpusExclusionFilter(root: string, factory: LanguageFactory): Promise<unknown>;
function extractFile(root: string, relPath: string, composer: DefaultSymbolIdComposer, factory: LanguageFactory):
  FileExtraction | null;
function buildSymbolDefs(extraction: FileExtraction): SymbolDefinition[];
// src/core/domains/trajectory/codegraph/symbols/symbol-table.js
class InMemoryGlobalSymbolTable { upsertFile(relPath, defs): void; size(): number }
// src/core/domains/language/ruby/resolver/ruby-resolver.js
class RubyCallResolver { resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null }
```

Produces: a CLI printing `compared N sites · mismatches M · drift D`, exiting
non-zero when `M > 0` or `D > 0`, and printing the first 20 mismatching rows as
JSON.

### Steps

- [ ] Read `scripts/spikes/ruby-walker-composition-parity.ts` in full (118
      lines) — the `--before-root` dynamic-import mechanism, the arg reader, the
      exit-code convention are all copied from it.
- [ ] Read `scripts/codegraph-chain-tally.ts:300-390` — the two-pass corpus walk
      (`collectSourceFiles` → `extractFile` → `upsertFile` +
      `Object.assign(classExtends, …)`, then a resolve loop over
      `extraction.chunks[].calls`) is copied from it. Skip a call whose
      `call.dispatch !== undefined`, exactly as the tally does.
- [ ] Create the harness. The BEFORE side is the other checkout's
      `RubyCallResolver`; the AFTER side is this tree's, cross-checked against
      the one the factory hands production:

```ts
/**
 * Ruby resolver cross-checkout parity (E1 seam 3, bd 9fgdi).
 *
 * `codegraph-chain-tally.ts` has chain specs for python and java only, so a
 * Ruby relocation has no tally gate. This is the resolver half of the seam's
 * byte-identical gate, and it is stronger than a tally triple: it compares
 * PER CALL SITE, so a relocation that moved forty sites from one target to
 * another fails here and scores identically there.
 *
 * ONE corpus walk, ONE symbol table, ONE `CallContext` per chunk, two
 * resolvers: this tree's `RubyCallResolver`, and the one dynamically imported
 * from `--before-root` — another checkout of this repo pinned at the
 * pre-relocation commit. Both answer the same `CallRef`, so a difference is
 * the relocation and nothing else. No baseline file, no earlier run, no
 * question about which commit the BEFORE numbers came from.
 *
 * `drift` is the same guard the tally's `chainDrift` is: this tree's direct
 * `new RubyCallResolver()` must answer identically to
 * `LanguageFactory.create("ruby").resolver`. Non-zero means the harness is no
 * longer exercising production and every number it prints is void.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-resolver-parity.ts \
 *     --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon \
 *     --before-root /abs/path/to/pre-relocation/checkout [--limit 20000]
 */
```

- [ ] Load the BEFORE resolver the way the walker harness loads its extractor —
      dynamic import, explicit failure when the export is missing:

```ts
async function beforeResolver(beforeRoot: string): Promise<RubyCallResolver> {
  const modulePath = resolvePath(beforeRoot, "src/core/domains/language/ruby/resolver/ruby-resolver.ts");
  const loaded = (await import(modulePath)) as { RubyCallResolver?: new () => RubyCallResolver };
  if (typeof loaded.RubyCallResolver !== "function") {
    throw new Error(`--before-root checkout exports no RubyCallResolver: ${modulePath}`);
  }
  return new loaded.RubyCallResolver();
}
```

      tsx transpiles the other checkout's `.ts` without type-checking it, so the
      structural mismatch between the two trees' `CallContext` declarations is a
      non-issue at runtime — the same property is true of the walker precedent.
- [ ] Compare with the tally's `sameTarget` semantics (both `null`, or same
      `targetRelPath` AND same `targetSymbolId`). Import it rather than
      restating it: `import { sameTarget } from "../codegraph-chain-tally.js"`.
- [ ] Run it and record the result:

```bash
BEFORE=$(mktemp -d)/before
git worktree add "$BEFORE" HEAD~1   # the commit before Task 1's
npx tsx scripts/spikes/ruby-resolver-parity.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon \
  --before-root "$BEFORE" --limit 20000
```

      Gate: `mismatches 0`, `drift 0`. A non-zero `mismatches` means a cut was
      not byte-identical — the printed rows name the receiver and the two
      targets, which points at the branch.
- [ ] Time both a BEFORE-only and an AFTER-only run on the same machine to
      confirm the fold costs nothing measurable; the ports indirection is one
      property read per hop.
- [ ] Commit: `test(scripts): cross-checkout Ruby resolver parity harness (9fgdi)`.

---

## Task 3: Python ports and the `chainType` pass

**Files**

- CREATE `src/core/domains/language/python/resolver/python-receiver-type-ports.ts`
- CREATE `src/core/domains/language/python/resolver/strategies/python-chain-type.ts`
- CREATE `tests/core/domains/language/python/resolver/strategies/python-chain-type.test.ts`
- MODIFY `src/core/domains/language/python/resolver/strategies/shared.ts`
- MODIFY `src/core/domains/language/python/resolver/strategies/python-local-binding.ts`
- MODIFY `src/core/domains/language/python/resolver/strategies/index.ts`
- MODIFY `src/core/domains/language/python/resolver/python-chain-factory.ts`

**Interfaces**

Consumes:

```ts
// kernel/receiver-type-propagation.js
function propagateReceiverType(receiver, atLine, ctx, ports): TypeRef | undefined;
function stripCallArgs(segment: string): string;
// contracts/types/codegraph.js
function resolveLocalBinding(bindings, varName, atLine): LocalBinding | undefined;
function pickSingleCandidate<T>(candidates: readonly T[], mode: AmbiguousResolveMode): T | null;
// python/resolver/strategies/python-local-binding.js
function resolveTypeFile(bareType: string, ctx: CallContext): string | null;
// python/resolver/strategies/shared.js
function lastSegment(qualified: string): string;
function walkClassExtendsForMethod(startClass, member, ctx, mode): SymbolResolutionTarget | null;
// CallContext, run-global
ctx.structuredReturnTypes?: Record<string, TypeRef>;  // "run" | "Cls#run" | "Cls.run" | "Outer.Inner#run"
ctx.classFieldTypes?: Record<string, Record<string, string>>;  // class SHORT name → attr → type name
```

Produces:

```ts
// python/resolver/python-receiver-type-ports.ts
export const PYTHON_RECEIVER_TYPE_PORTS: ReceiverTypePorts;
export const PYTHON_CHAIN_MAX_HOPS_ENV = "CODEGRAPH_PY_CHAIN_MAX_HOPS";
// python/resolver/strategies/shared.ts
export function resolvePythonMemberOnType(
  typeName: string, member: string, ctx: CallContext, mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null;
// python/resolver/strategies/python-chain-type.ts
export class PythonChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainType";
  constructor(cfg: ResolverConfig);
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome;
}
```

### Steps

- [ ] Extract the member lookup from
      `PythonLocalBindingSymbolResolutionStrategy#resolveByLocalType` into
      `shared.ts` so both passes read one implementation
      (`memory/feedback_no_duplication_in_strategies.md`). The extracted
      function is the part AFTER `resolveTypeFile` — the narrowed
      `lookupByShortName` filter, `pickSingleCandidate`, and the
      `classExtends` walk — and it returns `null` when the member is not found
      anywhere in the chain. `resolveByLocalType` keeps its own file-only
      fallback (`{ targetRelPath, targetSymbolId: null }`) on that `null`, so
      its behaviour does not move:

```ts
/**
 * Resolve `<typeName>.<member>` inside the file that defines `typeName`, then
 * up its IN-PROJECT `classExtends` chain. `null` when no class in the chain
 * defines the member — the CALLER decides whether that is a file-only edge
 * (a direct local binding, bd tea-rags-mcp-yrs0 / 86qfb) or a DROP (a folded
 * chain type, which has no measurement supporting the weaker answer).
 */
export function resolvePythonMemberOnType(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeFile(bareType, ctx);
  if (!targetFile) return null;
  const candidates = ctx.symbolTable
    .lookupByShortName(member)
    .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  const parent = ctx.classExtends?.[bareType];
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}
```

      `resolveTypeFile` currently lives in `python-local-binding.ts`; move it to
      `shared.ts` in the same edit so `shared.ts` does not import a strategy.
      Re-export it from `python-local-binding.ts` if anything else imports it —
      check with
      `/usr/bin/grep -rn "resolveTypeFile" src tests scripts` first.
- [ ] `npx vitest run tests/core/domains/language/python` — green BEFORE the new
      strategy exists. The extraction is behaviour-preserving; if a Python test
      moves, the extraction was not.
- [ ] **Thread the run-global type channels into both harnesses, and commit
      that on its own, BEFORE the strategy exists.** Neither harness builds a
      `CallContext` carrying `structuredReturnTypes` today, so a `chainType`
      inserted first would measure a no-op and report green (decision 7).
      `codegraph-chain-tally.ts:265` and `py-codegraph-jedi-oracle.ts:179`
      accumulate `classExtends` across every pass-1 file already; the type
      channels ride the same barrier:

```ts
// pass 1, beside `Object.assign(classExtends, extraction.classExtends ?? {})`
Object.assign(structuredReturnTypes, extraction.structuredReturnTypes ?? {});
Object.assign(functionReturnTypes, extraction.functionReturnTypes ?? {});
Object.assign(classAncestors, extraction.classAncestors ?? {});

// buildCallContext / the oracle's inline context literal
  classFieldTypes: extraction.classFieldTypes,
  localBindings: chunk.localBindings,
  classExtends,
  structuredReturnTypes,
  functionReturnTypes,
  classAncestors,
```

      This mirrors what `CodegraphRunState` does at the real pass-1→pass-2
      barrier, which is why `classExtends` was already shaped this way. Commit
      as `test(scripts): thread run-global type channels into the Python
      harnesses (9fgdi)`.
- [ ] Dump the five BEFORE oracle runs now — harness threading applied, strategy
      not yet inserted. Invocation in "Context the implementer needs". Keep
      `/tmp/e1s3-before-*.ndjson`; Task 4 diffs against them.
- [ ] Create `python-receiver-type-ports.ts`. Three ports have real bodies; the
      fourth is the env read:

```ts
/**
 * Python's four answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`).
 *
 * The channels are the ones Python already carries: `localBindings` for a
 * variable, `classFieldTypes` for `self.<attr>`, and `structuredReturnTypes`
 * for what a call yields — the last of which the annotation facet fills and
 * nothing read until this seam.
 *
 * Frozen module-level singleton: `ctx` is an argument, so a corpus-scale run
 * allocates nothing per call site.
 */
const PYTHON_CLASS_HEAD = /^[A-Z]\w*$/;

/**
 * `self` is the enclosing class as an INSTANCE; `Cls(…)` is a constructor call
 * and therefore also an instance; a bare name is a local variable. Nothing
 * else — an unbound bare name in Python is a `NameError`, not a self-call, so
 * Ruby's `nullaryReceiverType` has no analogue here.
 *
 * The local-variable branch is only ever reached as a chain HEAD:
 * `localBinding` runs before `chainType` and is terminal (resolved or DROP)
 * for a bare bound receiver, so a single-segment receiver never gets here.
 */
function pythonSingleHopType(receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined {
  if (receiver === "self") {
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    return enclosing === undefined ? undefined : { form: "instance", name: enclosing };
  }
  if (receiver.endsWith(")")) {
    const bare = stripCallArgs(receiver);
    if (!PYTHON_CLASS_HEAD.test(bare) || resolveTypeFile(bare, ctx) === null) return undefined;
    return { form: "instance", name: bare };
  }
  const bound = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  return bound === undefined ? undefined : { form: "instance", name: bound.type };
}
```

- [ ] Add `seedHead`. Only the module-qualified CONSTRUCTOR seeds — `mod.Cls()`
      is an instance of `Cls`, `mod.Cls` is the class object, and the raw link
      is what tells them apart:

```ts
/**
 * A head that is a module alias rather than a value: `mod.Cls()`.
 *
 * The link arrives RAW so the parens are still visible, and they decide the
 * form: `mod.Cls().run()` dispatches an INSTANCE method, `mod.Cls.run()` a
 * static one. Collapsing both to one form would send half these sites to the
 * wrong symbolId, which is the failure mode this program is gated against.
 *
 * The head must actually be imported and the class must actually be defined
 * in the file that import maps to. A capitalized first link alone is not
 * evidence — `os.Path` in a project that never imports `os` is nothing.
 */
function pythonSeedHead(
  head: string,
  firstLink: string | undefined,
  ctx: CallContext,
): { type: TypeRef; consumedMembers: 0 | 1 } | undefined {
  if (firstLink === undefined) return undefined;
  const member = stripCallArgs(firstLink);
  if (!PYTHON_CLASS_HEAD.test(member)) return undefined;
  const imported = ctx.imports.some((imp) => pythonImportMatchesReceiver(imp.importText, head));
  if (!imported || resolveTypeFile(member, ctx) === null) return undefined;
  const form = firstLink.endsWith(")") ? "instance" : "class";
  return { type: { form, name: member }, consumedMembers: 1 };
}
```

- [ ] Add `memberTypeOf` — the two-channel authority, ATTRIBUTE before RETURN.
      An attribute and a method can share a name; the attribute is the narrower
      statement (it names the class that owns it) and `classFieldTypes` only
      holds constructor-assigned or annotated fields, so it is the safer first
      read:

```ts
/**
 * What calling / accessing `member` on a receiver of type `recv` yields.
 *
 * Two channels, attribute first:
 *  1. `classFieldTypes[<class>][member]` — `self.repo` inside `Svc` is a
 *     `Repo`, written by the walker's `__init__` inference and by the
 *     annotation facet's `ivar` facts.
 *  2. `structuredReturnTypes[<symbolId>]` — what `member` RETURNS, keyed by
 *     the callee's own symbolId: `Cls#member` on an instance receiver,
 *     `Cls.member` on a class receiver. Nested owners already arrive joined
 *     with `.` (`python/kernel.ts:41`), so never re-compose the key.
 *
 * A `container` or `union` receiver yields nothing: Python's `list[Foo]` types
 * the LIST, not an element, so unwrapping it the way Ruby unwraps a YARD
 * `Array<Post>` would resolve `xs.append` against `Foo`. The annotation facet
 * already declines to emit those as bindings (its decision 4); this is the
 * same rule stated on the read side.
 */
function pythonMemberTypeOf(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  const fieldType = ctx.classFieldTypes?.[recv.name]?.[member];
  if (fieldType !== undefined) return { form: "instance", name: fieldType };
  const separator = recv.form === "class" ? "." : "#";
  return ctx.structuredReturnTypes?.[`${recv.name}${separator}${member}`];
}
```

- [ ] Add `maxHops` and the frozen singleton:

```ts
export const PYTHON_CHAIN_MAX_HOPS_ENV = "CODEGRAPH_PY_CHAIN_MAX_HOPS";

/** Read the cap per call so a test env override needs no module reload. */
function pythonMaxHops(): number {
  const raw = process.env[PYTHON_CHAIN_MAX_HOPS_ENV];
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

export const PYTHON_RECEIVER_TYPE_PORTS: ReceiverTypePorts = Object.freeze({
  singleHopType: pythonSingleHopType,
  seedHead: pythonSeedHead,
  memberTypeOf: pythonMemberTypeOf,
  maxHops: pythonMaxHops,
});
```

- [ ] Create the strategy. It is a thin pass on purpose — the fold decides the
      type, `resolvePythonMemberOnType` decides the target, and this file
      decides only the three verdicts:

```ts
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { propagateReceiverType } from "../../../kernel/receiver-type-propagation.js";
import { PYTHON_RECEIVER_TYPE_PORTS } from "../python-receiver-type-ports.js";
import { resolvePythonMemberOnType, resolveTypeFile, lastSegment, type ResolverConfig } from "./shared.js";

/**
 * Typed-receiver resolution through the shared chain fold (E1 seam 3).
 *
 * The entry condition is TYPEDNESS, not receiver shape — whatever
 * `propagateReceiverType` threads to a single class or instance, this pass
 * resolves the member on. Two shapes it exists for, neither of which any
 * earlier pass owns:
 *
 *   x = svc.build()   →   x.run()          binding → return type
 *   self.repo.get(id).save()                field → return → member
 *
 * `localBinding` needs the receiver itself to be bound and is terminal for
 * those it owns; `selfField` handles exactly ONE access level and CONTINUEs on
 * `self.foo.bar` (bd tea-rags-mcp-rjuc). Everything with a call or a second
 * dot in it reached `importedName` / `importMatch` / `globalShortName` before
 * this pass — the three that produce 9,892 of the E0 baseline's phantoms.
 *
 * **Three-state semantics:**
 *
 * - `CONTINUE` — the fold produced nothing, or a `union` / `container` with no
 *   single class to look up. The call reaches the later passes exactly as it
 *   does today; nothing regresses by absence.
 *
 * - `resolved(target)` — the folded type resolved to one in-project symbol for
 *   the member, directly or up its `classExtends` chain. Terminal.
 *
 * - `DROP` — the folded type is known and is NOT in the project (builtin,
 *   stdlib, third-party), or is in the project but defines the member nowhere
 *   in its chain. NOTE the difference from `localBinding`, which commits a
 *   file-only edge in the second case: that fallback is measured for a DIRECT
 *   binding (bd 86qfb) and unmeasured for a type arrived at by folding hops,
 *   and this program is precision-gated. If the oracle A/B shows `lost`
 *   concentrated on this shape, the file-only fallback is the fix — do not
 *   pre-emptively add it.
 *
 * **Chain placement:** AFTER `localBinding`, BEFORE `importedName`. Both
 * offline harnesses call `createPythonSymbolResolutionChain`, so the insertion
 * reaches them with no second edit (bd tea-rags-mcp-3yxmy).
 */
export class PythonChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainType";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const receiver = call.receiver;
    if (!receiver) return CONTINUE;

    const type = propagateReceiverType(receiver, call.startLine, ctx, PYTHON_RECEIVER_TYPE_PORTS);
    if (!type || (type.form !== "class" && type.form !== "instance")) return CONTINUE;

    // A folded type whose file is not in the project is external — DROP rather
    // than hand the call to the short-name passes.
    if (resolveTypeFile(lastSegment(type.name), ctx) === null) return DROP;

    const target = resolvePythonMemberOnType(type.name, call.member, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
```

- [ ] Export it from `strategies/index.ts` alongside the other six, then insert
      ONE line into `createPythonSymbolResolutionChain` — between
      `PythonLocalBindingSymbolResolutionStrategy` and
      `PythonImportedNameSymbolResolutionStrategy`:

```ts
    new PythonLocalBindingSymbolResolutionStrategy(cfg),
    new PythonChainTypeSymbolResolutionStrategy(cfg),
    new PythonImportedNameSymbolResolutionStrategy(cfg, mapper),
```

      Update the ordered pass list in `python-resolver.ts`'s docblock to match.
      Nothing else in the factory moves.
- [ ] Write
      `tests/core/domains/language/python/resolver/strategies/python-chain-type.test.ts`.
      Follow the fixture style of the neighbouring
      `strategies/*.test.ts` — a hand-built `InMemoryGlobalSymbolTable` and a
      literal `CallContext`, no corpus. Every positive case asserts the EXACT
      `targetSymbolId`, never just "resolved":
      - `x = svc.build(); x.run()` — `localBindings.svc` → `Svc`,
        `structuredReturnTypes["Svc#build"]` → `instance Widget`,
        `Widget#run` in the table. Receiver `svc.build()`, member `run` →
        `targetSymbolId === "Widget#run"`.
      - `self.repo.get(id).save()` — `callerScope` `["Svc"]`,
        `classFieldTypes.Svc.repo` → `Repo`,
        `structuredReturnTypes["Repo#get"]` → `instance Row`, `Row#save` in the
        table → `targetSymbolId === "Row#save"`.
      - nested owner: `structuredReturnTypes["Outer.Inner#build"]` reached from
        a receiver typed `Outer.Inner` → asserts the `.`-joined key is read
        verbatim, not re-composed with `::`.
      - class form: `mod.Cls.make()` seeds `{form:"class"}`, so the return key
        read is `Cls.make`, not `Cls#make`.
      - instance form: `mod.Cls().run()` seeds `{form:"instance"}` → `Cls#run`.
      - position-aware binding: `svc` bound to `A` at line 3 and to `B` at
        line 9; a call at line 5 folds through `A#build`, at line 11 through
        `B#build`. Two different `targetSymbolId`s from the same receiver text.
      - NEGATIVE — external receiver: the folded type is `Session` with no
        definition in the table and no import mapping → `DROP`, and assert it
        is DROP rather than CONTINUE so the later passes are provably cut off.
      - NEGATIVE — builtin: `d = dict(); d.items().x()` → the head has no
        binding, the fold yields nothing → `CONTINUE`.
      - NEGATIVE — union / container: a `structuredReturnTypes` entry of
        `{form:"union", members:[A,B]}` mid-chain → `CONTINUE`, no fan-out, no
        first-member guess.
      - NEGATIVE — unknown hop: `structuredReturnTypes` has no key for the
        middle member → `CONTINUE` (STOP-at-unknown, nothing fabricated past
        it).
      - hop cap: a five-link receiver under the default cap of 4 → `CONTINUE`.
      - no receiver → `CONTINUE`.
- [ ] Add ONE case to
      `tests/core/domains/language/python/resolver/python-chain-factory.test.ts`
      asserting the composed order now reads
      `super, selfField, selfMember, localBinding, chainType, importedName,
      importMatch, globalShortName`. That test is what stops a future reorder.
- [ ] `npx vitest run tests/core/domains/language/python`; `npm run type-check`;
      `npx eslint --max-warnings 0` on the touched files.
- [ ] Commit: `feat(language): resolve Python chained receivers by folded type (9fgdi)`.

---

## Task 4: gates and navigators

**Files**

- MODIFY `src/core/domains/language/CLAUDE.md`
- MODIFY `src/core/domains/language/ruby/CLAUDE.md`
- MODIFY `src/core/domains/language/python/CLAUDE.md`

**Interfaces**

Consumes: everything Tasks 1–3 produced, plus the BEFORE dumps from Task 3.
Produces: measured numbers, three navigator bullets, and a bead-closing
`--reason` a reader can check without rerunning anything.

### Steps

- [ ] Ruby relocation gate. Re-run Task 2's harness against the pre-Task-1
      commit and record the output verbatim:

```bash
npx tsx scripts/spikes/ruby-resolver-parity.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon \
  --before-root "$BEFORE" --limit 20000
```

      Gate: `mismatches 0`, `drift 0`. Also
      `npx vitest run tests/core/domains/language/ruby` with the file and
      passing counts from Task 1 step 1, and
      `git diff --stat -- tests/core/domains/language/ruby` empty.
- [ ] Python row-level oracle A/B. Dump AFTER for all five corpora and diff
      against Task 3's BEFORE dumps:

```bash
for c in flask ugnest httpx netbox polar; do
  echo "== $c"; node $D/diff-rows.mjs /tmp/e1s3-before-$c.ndjson /tmp/e1s3-after-$c.ndjson summary
done
```

      Gates, per corpus: gross `lost` **0**; `match` up; `annotationReturn`
      `missed` down; `phantom` not up. `unmatchedKeys` must stay at whatever
      the BEFORE/AFTER pair produced before this seam — a jump means the two
      walks disagree and the diff is void, not that the strategy helped.
      Record the five triples in the task notes; the `polar` and `netbox`
      numbers are the ones that decide the seam, since they carry the bulk of
      the `annotationReturn` losses.
- [ ] `lost > 0`: read the LOST SITES block
      (`node $D/diff-rows.mjs before after lost`) before changing anything.
      Group by `receiverKind` and by `before.answeredBy`. A cluster where the
      previous answer came from `localBinding` means the extraction in Task 3
      step 1 was not behaviour-preserving. A cluster answered by
      `globalShortName` that the oracle CONFIRMS means the DROP of decision 5
      is too strict for that shape and the file-only fallback is the fix — make
      that change explicitly, re-dump, do not widen the gate.
- [ ] Chain-drift gate, all five corpora:

```bash
for c in flask ugnest httpx netbox polar; do
  npx tsx scripts/codegraph-chain-tally.ts --corpus $c --lang python --quiet
done
```

      `chainDrift` must be 0 in every run. Non-zero means the rebuilt chain and
      the production resolver disagree — which after this seam can only mean
      something bypassed the factory.
- [ ] Perf A/B on netbox, same machine, back to back: the tally run with the
      strategy present versus the same command on the pre-Task-3 commit. Budget
      `wall ≤ +25%`, `RSS ≤ +20%`
      (`/usr/bin/time -l npx tsx scripts/codegraph-chain-tally.ts …`, read
      `maximum resident set size`). Over budget → the ports object is being
      built per call site, or a lookup became a scan. Both are code defects,
      not reasons to relax the budget.
- [ ] `npm run test:coverage` exit 0. Below threshold → delegate to the
      `coverage-expander` subagent per `.claude/CLAUDE.md`; do not lower a
      threshold and do not write the tests inline.
- [ ] Navigator bullets. `src/core/domains/language/CLAUDE.md` — one bullet
      under the resolver-chain material:

```markdown
- **Receiver chain typing is a kernel fold with per-language ports.**
  `kernel/receiver-type-propagation.ts` owns the walk — split on `.`, seed the
  head, thread each hop through `memberTypeOf`, STOP at the first unknown, cap
  the hop count, collapse the receiver form ONCE at the boundary. A language
  supplies four ports and gets multi-hop typing; it supplies them as a FROZEN
  MODULE SINGLETON, because the fold runs per call site and `ctx` is threaded
  as an argument precisely so nothing is allocated there. What an `@ivar` is,
  what a capitalized head means, which env caps the hops — all language, none
  of it in the kernel.
```

- [ ] `src/core/domains/language/ruby/CLAUDE.md` — a pointer, not a restatement:

```markdown
- `resolver/type-propagation.ts` is still the ADDRESS every consumer imports
  (`typeOfReceiver`, `ivarTypeName`, and the five vocabulary re-exports), but
  the chain WALK moved to `kernel/receiver-type-propagation.ts` in E1 seam 3.
  What stayed is what is Ruby: `@ivar` resolution over
  `ivarTypes` → `classFieldTypes`, the nullary self-call receiver, typed
  container index access, `CONST_HEAD` seeding via `declaredReturnType` then
  the gem catalogue, and `CODEGRAPH_RB_CHAIN_MAX_HOPS`. Change any of those
  here; change the walk in the kernel and re-run
  `scripts/spikes/ruby-resolver-parity.ts`.
```

- [ ] `src/core/domains/language/python/CLAUDE.md` — the read side of the
      annotation facet's channels:

```markdown
- `chainType` (`resolver/strategies/python-chain-type.ts`) is the only reader
  of `structuredReturnTypes`. It sits between `localBinding` and
  `importedName`, folds the receiver through
  `PYTHON_RECEIVER_TYPE_PORTS`, and is terminal both ways: a folded type that
  resolves gives an edge, a folded type outside the project DROPS rather than
  falling through to the short-name passes. `memberTypeOf` reads
  `classFieldTypes` (attribute) before `structuredReturnTypes` (return), and
  the return key IS the callee's symbolId — `Cls#run` on an instance receiver,
  `Cls.run` on a class one, `Outer.Inner#run` for a nested owner, already
  `.`-joined. A `container` or `union` receiver yields nothing on purpose:
  `list[Foo]` types the list, not an element.
```

- [ ] Commit: `docs(language): record the receiver-propagation seam in the navigators (9fgdi)`.

---

## Invariants

1. `git diff --stat -- tests/core/domains/language/ruby` is EMPTY at every
   commit in this plan.
2. Every symbol `ruby/resolver/type-propagation.ts` exported before Task 1 is
   exported after it, with the same name and the same signature.
3. `kernel/receiver-type-propagation.ts` imports nothing from
   `domains/language/<lang>/`.
4. The fold collapses the receiver form exactly once, at
   `propagateReceiverType`. Hops stay raw.
5. Ports are frozen module singletons; the fold allocates nothing per call
   site.
6. `createPythonSymbolResolutionChain` remains the ONE place the Python chain
   order is written down. No harness rebuilds it by hand.
7. Nothing this seam adds ever fans out. `chainType` returns one target or none.

## Mechanics

- Each task gets a FRESH Opus executor in its own worktree; the executor reads
  this plan and the two files named in its **Files** block, nothing else.
- Tool calls stay under 8 minutes. Reads are ≤ 300-line slices, ≤ 3 files per
  turn. Writes are ≤ 120 lines per call.
- Commits: `refactor(language): …` for Task 1, `test(scripts): …` for Task 2
  and the harness-threading commit, `feat(language): …` for Task 3,
  `docs(language): …` for Task 4. Every subject ends with `(9fgdi)` — the
  orchestrator replaces it with the real bead id when the beads are filed.
  Body wrapped at 100 columns, `Co-Authored-By` trailer per
  `.claude/rules/commit-rules.md`.
- No build, no `npm link`, no reindex. Every gate in this plan is offline.

## Self-review

- Names are identical across tasks: `ReceiverTypePorts`,
  `propagateReceiverType`, `stripCallArgs`, `CHAIN_MAX_HOPS_DEFAULT`,
  `RUBY_RECEIVER_TYPE_PORTS`, `PYTHON_RECEIVER_TYPE_PORTS`,
  `resolvePythonMemberOnType`, `PythonChainTypeSymbolResolutionStrategy`,
  chain name `chainType`.
- Every port has a Ruby body and a Python body — decision 2's table is the
  check, and `bindingAt` was dropped precisely because its two bodies would
  have disagreed.
- Every decision has a task: 1–3 → Task 1, 4 → Task 2, 5 → Task 3, 6 → Task 4,
  7 → Task 3's harness-threading step.
- No undefined symbol: `resolveTypeFile`, `lastSegment`,
  `walkClassExtendsForMethod`, `pickSingleCandidate`,
  `pythonImportMatchesReceiver`, `resolveLocalBinding`, `typeRefReceiverForm`,
  `returnTypeOf`, `declaredReturnType`, `nullaryReceiverType`,
  `catalogueForGemfile` all exist today at the paths cited.

## Open items this plan does NOT close

- **Ruby does not adopt the Python ports' shape.** Ruby's `singleHopType` keeps
  four branches in one function because splitting them would not be a
  relocation. If a third language arrives, that function is where to look for
  the next seam.
- **`functionReturnTypes` stays unread by `chainType`.** It is flat and keyed by
  bare method name; the annotation facet dropped it for the collision hazard
  (its decision 5) and this pass does not resurrect it.
- **Argument lists containing dots split wrong.** `svc.get(a.b).run()` folds as
  `svc`, `get(a`, `b)` and simply misses. Pre-existing in Ruby, out of scope.
- **No `cls` receiver.** `cls.method()` inside a `@classmethod` would seed a
  class form off `callerScope`; it is not in this seam because no baseline
  bucket measures it.
- **Whether `DROP` or a file-only edge is right for a folded type is decided by
  the oracle A/B, not by this plan.** Decision 5 picks DROP and Task 4 step 3
  says exactly what evidence would overturn it.
