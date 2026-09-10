# domains/language/python — navigator

## Resolver

- **`importText` is a persisted contract, not an internal string.** The walker's
  `collectPythonImports` emits `"a.b"`, `"a"` for `from a import b, c`, `"."`,
  `".a"`. The mapper, the external vocabulary and `importedName` all parse it.
  Changing its shape is a walker-version bump and a reindex, not a refactor.
- **`import a.b` binds `a`.** Python binds the TOP package unless the statement
  aliases; `importedBindings` records `{ a: "a.b" }`. Getting this backwards
  makes every `os.path.join` look like a call on a module named `path`.
- **Ask membership, never the disk.** `hasFile` / `hasFilesUnder` are the only
  oracle in `resolver/`. Pass 2 runs against a hydrated symbol table whose
  working tree may have moved on, and a per-import `statSync` is a syscall storm
  on a 24k-file corpus.
- **Empty `__init__.py` files are real files with zero symbols.**
  `hasFilesUnder` cannot tell one from a PEP 420 namespace directory, and the
  two get different answers — always ask `hasFile` for the `__init__.py` itself.
- **Never call `symbolTable.lookupByShortName` here — call
  `lookupPythonSymbolsByShortName`.** One table is built per run over every
  `CODEGRAPH_LANGUAGES` extension and `SymbolDefinition` carries no `language`
  field, so the raw lookup answers with any file that spells the name: polar's
  `range(...)` resolved to `Paginator.tsx#range`. The wrapper in
  `resolver/strategies/shared.ts` keeps `.py` candidates only, and the extension
  list is the literal in `vocabulary/source-extensions.ts` because `language` is
  a leaf domain that may not import the registry from `trajectory/`.
- **A BARE call reaches module scope, an enclosing function, an import, or a
  builtin — never a class body.** `globalShortName`'s `receiver === null` arm
  rejects a pick that is none of those: `open(path, mode)` in one file cannot
  name `FlaskClient#open` in another, and a builtin the caller's file does not
  shadow DROPs rather than picking a namesake (`importedName` sits one slot
  earlier and answers first when an import bound the name). The rejection runs
  AFTER `pickSingleCandidate`, not as a filter before it — filtering first would
  let an unreachable candidate stop counting toward ambiguity and mint a new
  cross-file edge. The `self` arm keeps the full candidate set, because
  `self.open()` IS attribute lookup down the MRO.
- **`PythonCallResolver` owns exactly ONE `PythonImportFileMapper`** and hands
  it to the chain factory, the cone locator and the external vocabulary. The
  memo is keyed by symbol-table identity and invalidated on `size()`, so a
  second instance is a second cold cache and a licence for two consumers to
  answer the same import differently.
- **The mapper answers TWO different questions, and only the second one follows
  re-exports.** `mapImportToFile` says which file a MODULE names;
  `resolveExportedName` says which file DECLARES a name, walking the file's own
  `from` statements out of the walker's `moduleReexports` channel. They diverge
  wherever a package re-exports — netbox's `core/models/__init__.py` declares
  nothing and star-imports six siblings. Four rules make the follow safe to add
  to a shipped path, and all four are load-bearing: it is consulted ONLY after
  the direct candidate filter fails to leave exactly one candidate, so nothing
  that resolves today moves; a file that declares the name is returned
  UNCHANGED; EXPLICIT entries beat stars, because an `as` alias names the source
  spelling and a star cannot; and stars are unanimous or REFUSED, because two
  sources declaring the name is the same ambiguity the caller declined to guess
  at. `MAX_REEXPORT_HOPS` is 3 with a visited set — a deeper tower or a
  re-export cycle answers the pre-seam refusal rather than a guess, and `null`
  means "no better answer than the file you came in with", never "absent".
- **`chainType` is the ONLY reader of `structuredReturnTypes`.**
  `resolver/strategies/python-chain-type.ts` sits between `localBinding` and
  `importedName` and folds the receiver through the kernel walk with
  `createPythonReceiverTypePorts(mapper)` — called once in the constructor, off
  the resolver's own mapper, never per call site. It is terminal BOTH ways: a
  folded type that resolves gives an edge, a folded type whose file is outside
  the project DROPs rather than falling through to `globalShortName`. It does
  NOT copy `localBinding`'s file-only fallback — that is measured for a DIRECT
  binding and unmeasured for a type reached by folding hops. `memberTypeOf`
  reads `classFieldTypes` (attribute) before `structuredReturnTypes` (return);
  their two key conventions are under Mechanics below. A `container` or `union`
  receiver yields nothing on purpose — `list[Foo]` types the list, not an
  element.
- **The stdlib check runs BEFORE the mapper — in two places.** The mapper probes
  the caller's ancestor directories first, so `import json` from
  `src/flask/tag.py` would otherwise land on flask's own
  `src/flask/json/__init__.py`. Which module the interpreter binds is a sys.path
  question no static root inference answers. `PythonExternalVocabulary` carries
  the guard, and so does
  `PythonImportedNameSymbolResolutionStrategy.resolveBinding`, which DROPs when
  an ABSOLUTE `importText` heads a stdlib module — measured cause, the ancestor
  scan reaching `netbox/utilities/json.py` and turning 45 stdlib calls into
  in-project phantoms. Absolute-import semantics are what make the DROP correct
  rather than merely conservative: a project `json.py` is reachable as
  `from utilities import json`, never as `import json`, so a RELATIVE `.json`
  import is deliberately left alone.
- **`importedName` answers THREE receiver shapes, and only SINGLE-HOP ones, each
  arm falling to the next on a decline.** A class receiver (`Device.objects`)
  resolves through the symbol the binding names; a module receiver
  (`columns.ColorColumn()`) resolves through the module text the binding
  composes — an `import_statement` records a MODULE PATH in `importedBindings`,
  a `from` form records an exported NAME, and
  `importedBindings[local] === importText` is the discriminator; a module-level
  VALUE (`client.query()` after `from .client import client`) resolves by short
  name inside the one file the import names, and only when the bound name is
  declared NOWHERE, so an inherited member on a real class never lands there.
  The composed module text is mapped INSTEAD of the parent package, because a
  PEP 420 namespace parent maps to `unknown`. Two ordering facts cost rows when
  they were wrong, so keep them: a declining arm must FALL THROUGH rather than
  return (polar's `from . import pan_transfer` maps to the package
  `__init__.py`, whose re-export hop pins the same-named route handler in
  `endpoints.py` — 8 rows the module arm resolves once it is asked); and the
  single-hop guard gates RESOLUTION only. A dotted receiver still gets the
  `external` verdict on its HEAD, because the fold question and the library
  question are not the same one. Measured cost of answering CONTINUE there: 95
  phantoms on netbox (`ContentType.objects`, `os.path`), 9 on ugnest, 2 on
  flask.
- **A bare class name as a CHAIN head is seeded by `pythonClassChainHeadSeed`,
  and that is deliberately not `singleHopType`'s `classHead` arm.** `seedHead`
  is reached ONLY from `propagateChain`, so `ObjectType.objects.get_for_model()`
  gets the seed while a single-hop `Cls.member()` receiver keeps falling to
  `importedName` exactly as before — which is what the `classHead` default
  protects, and why the arm was SPLIT rather than switched on. The seed is inert
  by construction: `consumedMembers: 0` hands the first link straight to
  `memberTypeOf`, and stop-at-unknown-hop unwinds the receiver to untyped unless
  that link carries a real field or return fact, so a class with no matching
  attribute reaches the same strategy it reaches today. A local binding on the
  same name WINS — a name Python rebound is a value, not the class.
- **A receiver that is nothing but MODULE TEXT gets a fourth arm, and its
  hardest case is a module shadowed by its own assignment.**
  `utilities.fields.ColorField()` spells two or three lowercase hops with no
  value in them, because `import utilities.fields` binds the TOP package;
  `importedName` composes the bound module text with the receiver's remaining
  segments, maps THAT, and reads the member off the file as a unique top-level
  declaration — tried before the multi-hop head check and returning only
  `resolved`, so an external or stdlib head keeps its DROP. The capital-letter
  test in `DOTTED_MODULE_RECEIVER` is load-bearing: PEP 8 spells modules
  lowercase, and it is what keeps `Event.id` — a column on a class, whose fold
  `chainType` owns — out of the module arm. The shadow case is
  `layout = layout.SimpleLayout(...)`: Python evaluates the RHS before it
  rebinds the name, so ON that line the receiver still denotes what the import
  bound, and `pythonSingleHopType` skips a binding established on the call's own
  line WHEN an import bound that same name. Narrow the gate any less and
  `x = Foo(); x.run()` on one line loses its type.
- **`callResultBindings` is folded at RESOLVE time, and that is the only layer
  where it can be.** The walker records the callee SPELLING a local was assigned
  from (`repository = SubscriptionRepository.from_session(session)` →
  `SubscriptionRepository.from_session`); `localBinding` folds it through the
  shared chain engine and reads the return off that class up the MRO. A
  cross-file return type and the callee's own hierarchy are both in scope only
  in the resolver, never in the walker. ONE hop — the returned ref is never
  re-folded — and a real `localBindings` entry always wins, because a walker
  binding is a type it READ and a fold is an inference. The bare-callee arm is
  opt-in through `createPythonCallBindingPorts` rather than added to the shared
  `pythonSingleHopType`: globally on, `Cls.member()` would be answered by
  `chainType` one pass EARLIER than `importedName` and through the legacy
  `classExtends` walk instead of the MRO. This is a SECOND channel and not a
  widening of `localCallBindings` — that one is bare-name-keyed and pairs with
  `functionReturnTypes`, which Python drops outright (one `def get(self) -> Foo`
  would speak for every `get` in the corpus).
- **A class field has TWO addresses, and the qualified one is what crosses a
  file.** `classFieldTypes` is per-file and keyed by class SHORT name;
  `classFieldTypesByClassKey` carries the same facts under the file-qualified
  `` `${relPath}::${dottedFq}` `` key `classAncestors` already uses, unioned
  run-global and threaded onto `CallContext`. `pythonInheritedMemberType` reads
  the own-class key first, then each linearized ancestor key, and falls back to
  the short-name map exactly as before — which is what lets a field declared by
  an ANCESTOR's `__init__` type a `self.<attr>` receiver at all. Both field
  collectors share one `self.<field>` reader so the two addresses cannot
  disagree about a type.
- **A member is looked up through the field type's MRO, not verbatim.**
  `resolvePythonMemberOnTypeThroughMro` owns the two steps between a type NAME
  and the C3 walk (name → file, file + name → class key); `selfField`,
  `chainType` and `localBinding` all ask it, so `self.client.build_request()`
  finds `build_request` on a mixin base of `SyncClientBase` instead of missing.
  A defining class pins ITS spelling, an external boundary before any definition
  DROPs, an unreadable hierarchy CONTINUEs, and ambiguity stays a CONTINUE —
  there is no fan-out here.
- **`namingConvention` is the one GUESS in the chain, and it survives on four
  gates.** `data_source.sync()` is a `DataSource` because that is the dominant
  naming discipline of every OO language. The neutral half — the class must
  EXIST, and it must have NO subtypes — is `kernel/naming-convention.ts`;
  Python's end is the alphabet it camelizes on, `classExists` demanding EXACTLY
  ONE project declaration of the short name (Ruby accepts several because
  Zeitwerk makes the FQ recoverable; Python has no such guarantee),
  `hasSubtypes` reading `classAncestors` because there is no `ctx.hierarchy`
  snapshot on this path, and the TERMINAL — the member must pin a symbol on the
  guessed class or its MRO, or NOTHING is emitted, never a file-only edge. It
  also declines for a receiver a real type fact already answers and for one
  bound from a call whose CALLEE HEAD the project does not declare; the second
  is the whole phantom story, and gating on the head's origin rather than on the
  binding's mere presence is what keeps `user = User.objects.get(...)` answered
  while `user = authenticate(...)` is not. It NEVER DROPs — a DROP would claim
  the receiver's type is known-and-foreign, which a guess cannot establish.
- **A bare call resolves to a same-file module def BEFORE the ambiguity guard.**
  Python resolves local → enclosing → MODULE → builtins for a bare name and
  never consults another file, so `globalShortName`'s same-file arm is the
  answer the interpreter gives, not a tie-break. Two restrictions carry that:
  `receiver === null` only (`self.x()` is attribute lookup down the MRO), and
  module-level targets only (`scope.length === 0` — a same-file `Cls#helper` is
  enclosing-scope evidence this pass does not read). A file declaring the name
  twice declines rather than guessing an order.
- **`importMatch` is GONE — its residual did not earn the slot** (bd
  tea-rags-mcp-rw1qk). The trailing-segment heuristic survived the
  `importedName` demotion holding only the receivers nothing bound, and the
  seeded oracle measured that residual: netbox 35 rows / 0 `match` (15 phantom,
  2 wrongFile, 18 chainOnly), flask 6 / 0, httpx 0, polar 60 / 9 `match` / 29
  phantom, ugnest 2 / 2 `match`. Eleven right answers against 44 phantoms is a
  losing trade for a precision-gated program, so the pass was deleted rather
  than parked. A dotted or unbound receiver now falls to `globalShortName`.
- **An inherited member is found on a C3 MRO, and the class KEY is
  file-qualified while the ancestor VALUES are import-qualified.** The key is
  `` `${relPath}::${dottedFq}` `` (`pythonClassKey` /`parsePythonClassKey` in
  `strategies/shared.ts`) — `classAncestors` is run-global, so two `Base`
  classes in two files must not conflate, and the caller side rebuilds it from
  `ctx.callerScope`. **The two scopes are not the same scope, and a class
  declared inside a FUNCTION is where they part**: the walker's
  `collectPythonClassAncestors` accumulates class containers only, while the
  chunker's `callerScope` also carries the enclosing `def`, so
  `_AuthenticatorSignature` inside `def Authenticator()` is keyed
  `…::_AuthenticatorSignature` and asked for as
  `…::Authenticator._AuthenticatorSignature`. An absent key is NOT a class with
  no bases — it linearizes to a singleton and reads `closed`, which suppresses
  every fallback the flavour below would have allowed (measured: one polar
  `super()` row, bd `9fgdi` gate record). The VALUES carry the DEFINING file's
  import binding (`a.b::Base`, `.base::Base`, `django.db::Model`, bare for a
  same-file class or a builtin), never the asking file's: that is what makes
  `MRO(RepositoryBase)` one order for every call site and therefore memoizable
  once per run behind `PythonAncestorLinearizerCache`.
  `createPythonAncestorPolicy` resolves the spellings and `mro.ts` merges them;
  the driver is the kernel's.
- **A base bound by `from m import *` arrives as a DISJUNCTION the walker
  wrote,** `bare|m1::Base|m2::Base` in declaration order, because only the
  walker still holds that file's star modules — the read path has the CALLER's
  imports, never the definer's. First `project` verdict wins; when none does the
  answer is `unknown`, NOT `external`, since "no candidate I could check is a
  project class" is weaker evidence than "this base IS a library class" and the
  two produce opposite verdicts one bullet down. A builtin bare head is decided
  before the split.
- **Two boundary flavours, and they are not interchangeable.** A miss reports
  `closed` (every branch ended on a project class), `external` (a branch left
  the project) or `unknown` (a branch could not be classified). `selfMember`
  CONTINUEs on `unknown` alone and DROPs the other two — a blanket CONTINUE
  hands netbox's 540 and polar's 193 `agreeExternal` rows to `globalShortName`
  and buys phantoms. `super` never CONTINUEs at all: it walks the same MRO with
  `startAfter: true` (dispatch begins after the enclosing class, never on it)
  and DROPs on anything but `closed`, because its fall-through is a known
  false-edge family (bd `pic4` / `4rgg`).
- **`classExtends` survives and is not redundant.** It stays single-base and is
  the walker-v2 fallback every ancestor consumer keeps for an index written
  before `classAncestors` existed, and it is `pythonTypeOwnsMembers`'s
  corroboration channel and the tail of `resolvePythonMemberOnType`, which is
  how `selfField` reaches a base class at all. The cache answers `undefined` for
  such a run, and each strategy takes its pre-seam path rather than answering
  from an empty map.
- **Chain order is a correctness argument, not a preference.** Eight passes:
  `super`, `selfField`, `selfMember`, `localBinding`, `chainType`,
  `namingConvention`, `importedName`, `globalShortName`, composed in ONE place
  (`resolver/python-chain-factory.ts` — both offline harnesses call it, because
  the hand-copied duplicates drifted and voided every number the oracle
  printed). See the pass list in `resolver/python-resolver.ts`; the guards
  (`super`, `selfField`, `selfMember`, `localBinding`) DROP rather than fall
  through, which is what keeps `serializer.is_valid()` off an unrelated class.
- Resolver architecture rules: `.claude/rules/resolver-architecture.md`.
  Cross-language mechanics: `src/core/domains/language/CLAUDE.md`.

## Walker — monolith + one type-fact pass

### Invariants

- **A new Python extraction facet is a new pass, never an edit to
  `extractFromPythonFile`.** `walker/passes.ts` lists them; `walker/passes/`
  holds them. The two paths coexist deliberately — do not collapse one into the
  other. Why: `mergeExtraction` is append-only, so a facet added inside the
  monolith silently outranks every pass instead of being ordered against them.
- **`CODEGRAPH_PY_LOCAL_TYPE_TRACKING` gates local bindings ONLY.**
  `pythonLocalTypeTrackingEnabled` (exported from `walker/walker.ts`) suppresses
  the walker's `localBindings` and the pass's `param` / `local` facts. It does
  NOT gate `classFieldTypes`, which the walker builds unconditionally and the
  pass extends. Why: flipping the flag to isolate a local-typing regression must
  not silently take the self-field channel with it.
- **An `@overload` stub yields `Cls#m` to the implementation that follows it,
  but only when there IS one.** `collectSymbols` dedups by symbolId keeping the
  first occurrence, so `walker/name-of.ts` returns `null` for a stub whose
  container declares the same name again without an `@overload` decorator. Why:
  the stub's body is `...`, so the winning range carried no calls and every call
  in the implementation fell to the enclosing CLASS chunk — `scope: []`, which
  `pythonEnclosingClass` reads as "no enclosing class". A stub-only group (a
  `Protocol` or ABC body) keeps the first stub: there the stubs ARE the
  declaration, and yielding would delete the symbol rather than relocate it.
- **Class-body assignments (`objects = <QS>.as_manager()`) feed the SAME two
  field channels as `self.<field> = …`, and they merge UNDERNEATH:** a
  constructor assignment for the same field name wins. Reversing the spread
  order silently retypes every field a class declares twice. Attribution is to
  the INNERMOST enclosing class and the field name is taken verbatim — no
  spelling is special-cased.
- **A Python signature is NOT a Ruby signature, because a Python positional
  parameter may be passed by name.** `walker/passes/python-def-signatures.ts`
  fills the four neutral channels the kernel's `ArityNarrower` / `KwargNarrower`
  read (`arity` / `kwargs` on the chunk, `argCount` / `kwargKeys` /
  `hasKwargSplat` on the `CallRef`). `arity` counts positional slots only, with
  a leading `self` / `cls` DROPPED for a def declared directly in a class body —
  the call site never passes the receiver — and kept for a `@staticmethod`,
  which binds nothing implicitly. `kwargs.required` holds KEYWORD-ONLY params
  with no default, because those are the only ones a call MUST name;
  `kwargs.optional` holds every nameable param — the positional-or-keyword names
  in declaration order, then the keyword-only defaults. That last part is
  load-bearing: `KwargNarrower`'s extra-unknown-key rule drops a candidate whose
  declared set misses a passed key, so filing `def f(timeout)` without `timeout`
  in `optional` would drop it on `f(timeout=3)`. A param left of `/` is
  positional-ONLY and is absent from `optional` while still counting toward
  arity. `*args` sets `arity.hasSplat`, `**kw` sets `kwargs.hasSplat`, and a
  bare `*` opens the keyword-only region without either. On the call side a
  `*xs` splat OMITS `argCount` rather than guessing — a missing count is "no
  evidence, keep every candidate", a wrong one drops the right target. Python
  writes NO `visibility` (`_name` is a convention, not a keyword),
  `acceptsBlock` or `paramNames`; both narrowers that read them keep every
  candidate on absent evidence. A `@property` is not marked in any way — an
  attribute read is not a call site, so no `CallRef` ever reaches its signature.
- **The class-body reader emits only on project-class EVIDENCE, and is SILENT
  rather than external otherwise.** A bare `X()` needs `X` declared in THIS
  file; `X.as_manager()` also accepts an import-bound name, because there
  Django's own verb rather than the name carries the claim.
  `objects = models.Manager()` and `name = CharField(…)` emit NOTHING. Why: an
  external fact makes `chainType` DROP where the call falls through to a later
  strategy today, so absence — which leaves the receiver untyped and `chainType`
  on CONTINUE — is what keeps that path byte-identical. There is no manifest
  gate and no framework registry to consult.

### Mechanics

- **Two coordinate conventions live side by side.** `classFieldTypes` is keyed
  by class SHORT name with a bare member name (`walker/walker.ts:201` and the
  pass's `pythonTypeChannels` both write that shape); `structuredReturnTypes` is
  keyed by the callee's full symbolId (`Outer.Inner#method`). The channel
  re-keying that reconciles them with the kernel store's Ruby-shaped output is
  in `passes/python-type-channels.ts`, and the reasoning is in
  `domains/language/CLAUDE.md` → Mechanics. The field facts are ALSO written
  under a third, file-qualified key — what that address is for is a Resolver
  bullet above, and both writers share one reader so the two cannot disagree.
- **`moduleReexports` is collected in the SAME walk as `imports`, and it has to
  be.** One entry per name a file's `import_from_statement`s bind —
  `{ exportedName, sourceModule, sourceName }`, a star as `exportedName: "*"`
  with no source name. `import a` and `from a import a` produce an IDENTICAL
  `ImportRef`, so only the node type separates them and only the walk that sees
  the node can tell. Reconstructing the channel from `imports` afterwards would
  be guessing. Who reads it, and under which rules, is a Resolver bullet above.
- **The annotation pass types a field from an `__init__` PARAMETER, not just
  from a constructor call.** `collectPythonClassFieldTypes` records a field only
  when the RHS is a constructor, so `self.client = client` off a
  `client: SyncClientBase` parameter wrote nothing; the facet pass emits an
  `ivar` fact for `self.<field> = <annotated parameter>` in ANY method — one
  hop, one nominal arm, no attribute chain.
