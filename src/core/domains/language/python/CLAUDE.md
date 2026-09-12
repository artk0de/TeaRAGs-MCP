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
  name `FlaskClient#open` in another, and a builtin no frame of the caller's own
  file shadows DROPs rather than picking a namesake (`importedName` sits one
  slot earlier and answers first when an import bound the name). In the
  CROSS-FILE guess that closes the arm the rejection runs AFTER
  `pickSingleCandidate`, never as a filter before it — filtering first would let
  an unreachable candidate stop counting toward ambiguity and mint a new
  cross-file edge. The same-file arms above it are the opposite case and are a
  bullet of their own below. The `self` arm keeps the full candidate set,
  because `self.open()` IS attribute lookup down the MRO.
- **`PythonCallResolver` owns exactly ONE `PythonImportFileMapper`** and hands
  it to the chain factory, the cone locator and the external vocabulary, so a
  second instance is a second cold cache and a licence for two consumers to
  answer the same import differently.
- **That mapper's memo is TWO memos, because the answers have two lifetimes.**
  Source roots and the import→file answers derived from them are keyed by
  symbol-table identity and invalidated on `size()`; the re-export halves
  (`resolveExportedName` / `resolveExportedModule`) are keyed by the IDENTITY of
  `ctx.moduleReexports`, which is what a run is — the state reassigns the object
  at every reset and hands the one object to every call of a run. Both provider
  and table outlive a run, so keying the re-export answers by the table let run
  N+1 read run N's declarers whenever `size()` had not moved: an `__init__.py`
  whose re-export target changed without adding or removing a symbol resolved
  through the old file forever (bd tea-rags-mcp-11qqk). The run half carries the
  table and its size as a generation stamp, because those answers ALSO read
  membership and a cold pass-1 refusal must not outlive the growth that turns it
  into a hit.
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
- **A THIRD question exists, and it terminates on a FILE rather than a
  declaration.** `resolveExportedModule` asks which file a package binds a name
  to as a MODULE, for the shape neither of the other two can answer:
  `from . import _datatable as datatable` declares no symbol, so `declaresName`
  is false at every hop and `resolveExportedName` returns `null`, while the
  composed `..components.datatable` names no file for `mapImportToFile` to find.
  The name denotes a sibling module and the answer is that module's file — 259
  polar rows. It shares the channel, the hop budget and the visited set with
  `resolveExportedName`, and it is DETERMINISTIC where that one is
  unanimity-gated: an explicit alias names exactly one module, so there is
  nothing to pick between. Stars carry no `sourceName` and are skipped, never
  dereferenced. `importedName`'s module arm asks it LAST, only once the composed
  module text has failed to pin a member, so every site that resolves today
  resolves to the same target.
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
- **The SAME-FILE class-receiver arm walks the MRO too, and its precision gate
  is a uniqueness rule rather than a filter.** `resolveSameFileClassReceiver`
  tries both `Cls.m` and `Cls#m` filtered to the caller's own file first — that
  path is untouched — and only then hops to `resolvePythonInheritedMember` under
  `spellingOrder: "classFirst"`, keyed by
  `pythonBoundClassKey(receiver, ctx.callerFile, ctx)`, which answers `null`
  unless the caller's file declares exactly ONE class of that name. It resolves
  or CONTINUEs, never DROPs, so `resolveStarImport` still gets its turn.
  `classFirst` is what the two class-receiver arms share and the reason the
  option exists at all; the DEFAULT stays `instanceFirst` because `selfMember`
  and `super` ask the same helper about a receiver that is an INSTANCE (10 polar
  rows, bd tea-rags-mcp-w205u, E4.4b).
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
- **The hop split is a PORT, and Python is the only language that took the
  bracket-aware one.** `kernel/receiver-type-propagation.ts` still defaults to
  `receiver.split(".")`; `createPythonReceiverTypePorts` supplies
  `splitReceiverHops`, which splits on `.` at bracket depth 0 and counts quotes,
  so `Notification(user=self.user, …)` is ONE hop and
  `datatable.Datatable[Benefit, S](…)` is two. It is a port rather than the
  fold's own rule because the same scan newly types 34 mastodon receivers
  (`StatusFilter.new(quote.quoted_status, account).filter_state_for_quote`) —
  gains, but unmeasured ones, and Ruby's gate is parity. An UNBALANCED receiver,
  which a truncated call text produces, yields the whole string as one hop.
  `splitAtBracketDepthZero` is the one scanner; the `cast` argument reader asks
  it for `,` rather than growing a second.
- **A chain HEAD can be a call, and three arms answer one.**
  `pythonSingleHopType`'s `endsWith(")")` branch strips the generic subscript
  before the class test (`Datatable[Benefit, S](…)` → `Datatable`), then tries
  `typing.cast(T, x)` — where the type IS argument one — then a lowercase call
  whose callee has a recorded return. That last arm USED to be gated on the
  symbol table pinning exactly one project definition of the name, because a
  bare key let a second same-named def speak for the first; the per-file key
  retired the gate and unlocked polar's 17 `get_client().member` heads (bd
  tea-rags-mcp-1v12o.1.7). Reachability still bounds it when no binding narrows:
  the caller's own module scope or an import that maps into the project, and
  nothing wider. `PYTHON_CLASS_HEAD` still refuses a bare lowercase NAME — that
  is E4.1.3's falsified population, and only a CALL with a recorded return
  qualifies.
- **A namesake short name is narrowed by the binding for THAT name, through one
  funnel.** `pythonImportBoundFile` (`strategies/shared.ts`) takes the candidate
  files a short name is declared in and keeps the one the caller's own import
  binding maps to — `mapImportToFile`, then one `resolveExportedName` /
  `resolveExportedModule` hop; no binding and the caller's own file declares the
  name, that file; anything else refuses. Both halves that used to refuse these
  rows now ask it: `resolveTypeFile` BEFORE its import-SET filter, which
  conflates "a file this caller imports something from" with "the file this
  caller's binding names" and so kept both polar `Subscription` candidates, and
  `pythonCallBindingType`'s bare-callee arm, which had no narrowing at all. The
  set-filter stays as the fallback, so a row it answers with no binding in sight
  still resolves to the same file. E5.1a's call-result arm needed a SECOND guard
  — the class the run-global fact named had to be declared in the narrowed file
  — because the bare key carried no provenance; E5.1c's per-file key states the
  provenance outright and the guard is gone (Mechanics below).
- **A module-alias seed asks the HEAD's own module, not the caller's imports.**
  `pythonModuleAliasSeed` keeps its original arm (the caller imports the module
  AND `resolveTypeFile` pins the class) and falls back to one step wider: map
  the head's import through `receiverModuleText`, then E4.6a's
  `resolveExportedModule` when that maps nowhere, and require the resulting file
  to DECLARE the class as a unique top-level symbol — exact-symbolId `lookup`,
  the same gate `moduleMemberTarget` uses. The caller never imports `Datatable`,
  only the module that holds it. `receiverModuleText` moved to
  `strategies/shared.ts` so both readers ask it the same way.
- **`-> Self` is recorded as a MARKER and substituted by the reader, through one
  helper.** The annotation facet resolves `Self` against the enclosing class
  everywhere except a RETURN, where it emits the literal name `Self`
  (`PYTHON_SELF_RETURN`). `pythonSubstituteSelfReturn` puts the class the
  RECEIVER names in its place, so `AccountRepository.from_session(s)` types as
  `AccountRepository` and not as the `RepositoryBase` that declared the
  classmethod — which is what the following hop needs. Two readers apply it and
  there is no third: `pythonInheritedMemberType` on the arm it answers from
  (which is what lets `selfField` read it on the same terms), and
  `pythonCallBindingType` terminally, so the marker cannot reach
  `resolveOnBoundType` — where the literal `Self` names no file and DROPs — down
  any arm a later seam adds (bd tea-rags-mcp-1v12o.1.6). A class receiver
  substitutes that class, an instance receiver its own type, an untyped receiver
  nothing.
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
  would speak for every `get` in the corpus). Its bare-callee arm admits a SOLE
  module-level def with no reachability test (`"acceptSoleDef"`), where the
  chain head and the field arm require the caller to reach it
  (`"requireReach"`); both are pre-E5.1c rules kept apart because each was
  measured on its own path, and neither can pick between two candidates.
- **A class field has TWO addresses, and the qualified one is what crosses a
  file.** `classFieldTypes` is per-file and keyed by class SHORT name;
  `classFieldTypesByClassKey` carries the same facts under the file-qualified
  `` `${relPath}::${dottedFq}` `` key `classAncestors` already uses, unioned
  run-global and threaded onto `CallContext`. `pythonInheritedMemberType` reads
  the own-class key first, then each linearized ancestor key, and falls back to
  the short-name map exactly as before — which is what lets a field declared by
  an ANCESTOR's `__init__` type a `self.<attr>` receiver at all. Both field
  collectors share one `self.<field>` reader so the two addresses cannot
  disagree about a type. The qualified arm was DEAD in production from f0xaa
  until E4.6c — `ResolverInputs` carried the channel and neither `CallContext`
  literal copied it in, so the MRO walk answered through the SHORT-name map
  while both offline harnesses built the qualified one and every oracle number
  in between was measured with an arm production did not have. Threading it is
  what makes the two agree; the guard that keeps them agreeing lives in
  `trajectory/codegraph/CLAUDE.md`.
- **A field assigned from a CALL is a spelling, not a type.**
  `classFieldCallResults` (`<relPath>::<dottedFq> → field → callee spelling`) is
  what the walker writes when it cannot name a class —
  `self.payment_repo = PaymentRepository.from_session(s)`,
  `self._provider = provider or get_geo_provider()`,
  `self._transport = self._init_transport(…)`. `pythonInheritedMemberType` folds
  it LAST, after both type channels miss on the class and on every ancestor, and
  ONE level: each arm re-enters the declared-member read, never the exported
  entry point, so a callee whose own return is itself a field call is silence.
  Three spellings and no fourth — a bare project function, `Cls.method` on a
  class that resolves into the project (its `-> Self` naming the RECEIVER
  class), and `self.<method>`.
- **A field with a type fact is never also a call-result fact, and a conflict is
  neither.** The walker excludes a field the type channels already answered for,
  and DROPS a field two methods assign from different callees rather than taking
  the last write — two spellings return two types, and a field that holds either
  is not evidence for a receiver.
- **A guarded fallback RHS still names a class.** `param or Default()` types
  from the RIGHT operand (the left is a bare name with no competing claim), and
  a ternary types only when BOTH arms call the same callee. `A() or B()` and
  `A(x) if p else B(y)` are unions and decline — the engine never widens.
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
- **A bare call resolves against the caller's own file BEFORE the ambiguity
  guard, and the arms inside that run in LEGB order — `E`, then `G`, then
  builtins.** Python resolves local → enclosing → MODULE → builtins for a bare
  name and never consults another file, so `globalShortName`'s same-file arms
  are the answer the interpreter gives, not a tie-break. The enclosing arm goes
  first: a def in the caller's own frame chain (deepest frame wins,
  `Cls.method#inner` before `Cls#inner`) beats the file's top-level namesake,
  which is what `_list_tabs#url` and `Blueprint._merge_blueprint_funcs#extend`
  need. Both same-file arms filter BEFORE the pick, which the final cross-file
  guess must never do — a frame in the caller's own chain is the binding the
  interpreter reaches, not one namesake among many, so a project-wide tie cannot
  make it wrong. `receiver === null` only, in every arm (`self.x()` is attribute
  lookup down the MRO), and a name declared twice in one frame declines rather
  than guessing an order.
- **`callerScope` omits the caller's own container, and `callerSymbolId` is the
  only witness for it.** `isEnclosingScope` therefore admits one trailing
  segment of slack — that is how a call in `_list_tabs`' body
  (`callerScope: []`) reaches `_list_tabs#url` at all. The slack is blind on its
  own: it admits any container the file declares at that depth, a class body the
  LEGB walk never enters included. The enclosing arm therefore spends the slack
  only when the extra segment equals the last segment of `callerSymbolId`, and a
  `@property` whose body calls the builtin of its own name — netbox's
  `ASNRange#range` — is what a prefix-only test costs. Frames at or below
  `callerScope`'s own depth need no witness. The trailing cross-file guess keeps
  the blind form — it sits behind the cardinality guard, where E4.0.5 measured
  the over-admission at zero cost.
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
- **"Once per run" is keyed by the IDENTITY of `classAncestors`, never by the
  symbol table** (bd tea-rags-mcp-z99hp). The cache and the pooled table both
  outlive a run, and the kernel linearizer memoises against the ctx it captured,
  so a table key handed run N+1 every one of run N's MROs. The table and its
  `size()` still STAMP the entry: base spellings resolve through membership, so
  a cold pass-1 refusal must not outlive the growth that turns it into a pin.
- **The ancestor policy asks `resolveExportedModule` for a base spelling that
  mapped NOWHERE, and only on the `unknown` branch.** `..components.datatable`
  is a package module ALIAS — `from . import _datatable as datatable` in the
  package's `__init__.py` — so `mapImportToFile` reads `unknown` and the MRO
  stops at a base it cannot name. The policy splits the text the way
  `joinModulePath` composed it, keeping a leading dot RUN with the package, and
  retries through E4.6a's sibling-module hop. The `unknown` gate is the guard,
  not a nicety: `mapAbsolute` answers `external` for an absolute text no root
  maps, and asking there would let a project package that happens to bind the
  last segment capture `django.db.models` (19 polar `super()` rows, bd
  tea-rags-mcp-w205u, E4.4c).
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
  from an empty map. **It is also keyed by the class SHORT name and unioned
  run-global, so a namesake in another file OVERWRITES it** — polar declares
  `CheckoutDoesNotExist` twice and the legacy `super()` walk left the MRO on the
  loser. `resolveSuperViaClassExtends` declines its FIRST hop when the enclosing
  class's own `classAncestors` name no such base AND the short name is declared
  in more than one file; both clauses are load-bearing, because netbox's
  star-import truncation makes the two channels disagree on a class declared
  once and must stay byte-identical. Every DEEPER hop of that walk, and every
  other reader of the map, still trusts a run-global short-name index (bd
  tea-rags-mcp-w205u, E4.4c — a channel defect, not a `super()` one).
- **Chain order is a correctness argument, not a preference.** Nine passes:
  `super`, `clsMember`, `selfField`, `selfMember`, `localBinding`, `chainType`,
  `namingConvention`, `importedName`, `globalShortName`, composed in ONE place
  (`resolver/python-chain-factory.ts` — both offline harnesses call it, because
  the hand-copied duplicates drifted and voided every number the oracle
  printed). See the pass list in `resolver/python-resolver.ts`; the guards
  (`super`, `selfField`, `selfMember`, `localBinding`) DROP rather than fall
  through, which is what keeps `serializer.is_valid()` off an unrelated class.
- **`cls` is the enclosing class, and `clsMember` is the only pass that says
  so.** It sits directly after `super` and asks `selfMember`'s question with
  `spellingOrder: "classFirst"`, because `classifyMethod` files a `@classmethod`
  as `Cls.m` while an undecorated `def` is `Cls#m` — the option reorders the two
  spellings and never excludes either, so `cls.instance_method()` still
  resolves. Three facts gate it, and a decorator check is NOT among them:
  `CallContext` carries no decorator channel, so the evidence is an enclosing
  class, a `cls` the walker did not BIND here, and an MRO that owns the member.
  The binding test is PRESENCE in `localBindings` / `callResultBindings` rather
  than the binding nearest the call, matching `classifyReceiverKind` exactly, so
  a chunk that writes `for cls in classes:` declines on both sides of the
  rebinding. Unlike the other receiver-idiom passes it CONTINUEs on a miss
  rather than DROPping: a DROP variant measured against all five corpora moved 0
  rows and 0 edges, so the guard is free — and free is not load-bearing, so it
  stays unclaimed rather than shipped on an argument (bd tea-rags-mcp-w205u,
  E4.4a).
- **`resolveDispatch` composes `[cone]` — `dynamic` is PARKED behind
  `CODEGRAPH_PY_DYNAMIC_DISPATCH`, default OFF (D10), and the LAST component
  declines every receiver another layer owns.** The flag is read once at
  composition, in production and in the oracle's parity stack alike, so a
  flag-off run is the pre-E4.1.3 cone byte for byte. The runner asks
  `resolveDispatch` BEFORE `resolve` and lets a non-empty fan REPLACE the
  chain's answer, so `resolver/dispatch/python-dispatch-gates.ts` is where the
  component earns its slot: bare / `self` / `cls` / dotted / call-or-index head
  / capitalised (`_LEADING_UNDERSCORE` included) / builtin-named receiver, a
  receiver with a local binding in force or an import binding, a receiver bound
  to a call the project cannot type (foreign head, or a `self.<member>` no file
  declares), a `coreAmbiguous` or builtin-named MEMBER — then, last because it
  is the only expensive one, the chain itself. Python cannot probe two named
  passes the way Ruby does (a bare name is answered by `namingConvention`,
  `importedName` OR `globalShortName`, and its guards DROP rather than
  continue), so `PythonChainAnswerProbe` runs the composed chain and memoises
  per `CallRef` identity with the `CallContext` identity beside it —
  `PythonCallResolver.resolve` reads the same entry, which is what keeps the
  runner's dispatch→resolve pair at ONE chain run per site. The fan cap is
  Python's own `PY_DISPATCH_FAN_MAX` (4, `CODEGRAPH_PY_DISPATCH_FAN_MAX` to
  re-measure), read ONCE at composition and floored by the corpus-adaptive
  policy in `resolveNarrowedFanout`; the cascade takes neither language
  injection, because the runtime-member question is asked one gate earlier and a
  literal receiver never survives the shape gates.
- **The `dynamic` component's measured precision is NOT the plan's estimate,
  both E4.1.3 stop rules fired, and that is why the flag defaults off** (bd
  tea-rags-mcp-w205u; numbers in
  `docs/superpowers/plans/2026-09-10-python-e4-1-dispatch-fanout.md`, Task
  E4.1.3). It fires on ~5× the sites E4.0.4 attributed to `untypedNameReceiver`,
  and the extra ones are receivers whose real type is a LIBRARY type: +83 new
  1:1 matches against +85 new fabricated edges across the five corpora, and
  `recall@fan` 0.344 on polar (n=122) against a 0.85 bar. What no gate here can
  see is the receiver's type — a module-scope `log = structlog.get_logger()` is
  invisible because `callResultBindings` reach the resolver per CHUNK, and an
  `except … as e` or a Django queryset local carries no binding fact at all.
- Resolver architecture rules: `.claude/rules/resolver-architecture.md`.
  Cross-language mechanics: `src/core/domains/language/CLAUDE.md`.

## Walker — monolith + one type-fact pass

### Invariants

- **A framework-shaped facet is gated on the project's DECLARED dependencies,
  and the gate is data on the vocabulary module.** `vocabulary/frameworks/`
  holds one module per framework carrying `activatedBy` (PEP 503-normalized
  distribution names, matched EXACTLY — `django-filter` is not `django`) and the
  facets it switches on; `pythonVocabularyFor(input.declaredDependencies)`
  composes the active set and the walker asks `hasFacet`. Today's only gated
  facet is `classBodyManagerFactory` — the `objects = SomeQuerySet.as_manager()`
  arm, where the name is evidence only because Django's own classmethod says so.
  The BARE arm of the same pass (`objects = SomeManager()`, name declared or
  import-bound) is NOT gated: it rests on project-class evidence with no
  framework in it, and gating it was measured to cost polar — which declares no
  Django and spells no `as_manager` — 8 real edges. Gate what the framework
  OWNS, not the pass that happens to serve it. Absent manifest (`undefined`) is
  NOT an empty set: no manifest anywhere leaves every vocabulary ACTIVE (Ruby's
  "no Gemfile → full catalogue" rule), while a manifest declaring nothing gates
  every conditional one off — conflating the two would silently untype every
  fixture, spike and un-packaged corpus. The set is built once per run by
  `infra/dependency-manifests.ts`, which walks every `pyproject.toml` /
  `requirements*.txt` under the root outside the vendored dirs and unions what
  `manifest.ts` parses out of them; `domains/language` contributes the
  recognizing and the parsing and touches no filesystem. Both production seams
  thread it — `CodegraphRunState.loadDeclaredDependencies` for the codegraph
  pass, the chunker worker's `buildChunker` for the cross-pass one — and so must
  every harness: `extractFile` takes it as its fifth argument and
  `readCorpusDeclaredDependencies` is what fills it, because a tally walked
  ungated is a measurement of a gate nothing ships.
- **A new Python extraction facet is a new pass, never an edit to
  `extractFromPythonFile`.** `walker/passes.ts` lists them; `walker/passes/`
  holds them. The two paths coexist deliberately — do not collapse one into the
  other. Why: `mergeExtraction` is append-only, so a facet added inside the
  monolith silently outranks every pass instead of being ordered against them.
- **`PYTHON_EXTRACTION_BEARING_NODE_TYPES` (`index.ts`) is a PRE-filter, so it
  must stay a SUPERSET of every node type any pass roots extraction in.** The
  gate runs on the native tree before materialization (the mechanism is a
  `domains/language/CLAUDE.md` bullet): a file bearing none of the six listed
  types is answered with the empty extraction and never walked. Add a pass that
  reads a type absent from the list and every file carrying only that type goes
  silently empty — no error, no chunk, no call, and a green suite stays green
  because every unit fixture contains a `def` or a `call`.
  `scripts/spikes/py-inert-file-proof.ts` is the check that does catch it: it
  runs the REAL walker over every file the list calls inert, on all five
  corpora, and asserts the answer was empty anyway. `future_import_statement` is
  listed beside the two ordinary import forms because tree-sitter-python gives
  `from __future__ import …` a grammar node of its own.
- **`CODEGRAPH_PY_LOCAL_TYPE_TRACKING` gates local bindings ONLY.**
  `pythonLocalTypeTrackingEnabled` (exported from `walker/walker.ts`) suppresses
  the walker's `localBindings` and the pass's `param` / `local` facts. It does
  NOT gate `classFieldTypes`, which the walker builds unconditionally and the
  pass extends. Why: flipping the flag to isolate a local-typing regression must
  not silently take the self-field channel with it.
- **A local binding carries the SPAN of the statement that establishes it, and
  the span is what the import-shadow rule reads.** `LocalBinding.endLine` is the
  `assignment` node's last line, emitted on both assignment branches (annotation
  and constructor) and on NEITHER parameter-hint branch — a `def` parameter is
  not a shadowing statement. Python evaluates a right-hand side before it
  rebinds the name, so throughout `line..endLine` the variable still denotes
  whatever it denoted above: netbox's
  `layout = layout.Layout(\n    layout.Row(…))` puts the module, not the class,
  on lines 205 and 206. `pythonBindingInForceAt` demotes the local back to the
  import over exactly that window, and its retry asks for `bound.line - 1`
  rather than `atLine - 1` — the line before the CALL would find the very
  binding being demoted. ABSENT `endLine` degenerates to the same-line test it
  replaces, so an index written by an earlier walker behaves as before. The
  binding's scope END is the CHUNK, not this field: `pythonLocalBindingsInRange`
  already clips a function-local shadow to its own def.
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
  rather than external otherwise.** A bare `X()` and `X.as_manager()` both take
  `declared ∪ importBound` — an import binding is enough because the emitted
  fact is a NAME, not an edge, and `resolveTypeFile` still has to place it in
  the project (widened for polar's `_client = SlackClient()`, E4.6c; it was
  declared-only until then). `objects = models.Manager()` emits NOTHING: the
  receiver of the dot is a module and nothing per-file can say which one. Why
  the silence matters: an external fact makes `chainType` DROP where the call
  falls through to a later strategy today, so absence — which leaves the
  receiver untyped and `chainType` on CONTINUE — is what keeps that path
  byte-identical. There is no manifest gate and no framework registry to
  consult.
- **A `Mapped[T]` annotation is TRANSPARENT, and that is a language-level
  reading rather than a framework one.** SQLAlchemy 2.0's declarative column
  states "this attribute holds a T" exactly as `ClassVar[T]` does, so `Mapped`
  sits in `PYTHON_TRANSPARENT_FIRST` beside `Annotated` / `Final` / `InitVar`
  and bare `Mapped` in `PYTHON_DECLINED_TYPE_NAMES`. Nested forms fall out of
  the existing rules — `Mapped[list[T]]` is a container of `T`,
  `Mapped["Customer"]` unquotes. An unknown generic base still keeps the BASE
  (`QuerySet[Foo]` is a `QuerySet`); `Mapped` is the exception the annotation
  states outright.

### Mechanics

- **Two coordinate conventions live side by side.** `classFieldTypes` is keyed
  by class SHORT name with a bare member name (`walker/walker.ts:201` and the
  pass's `pythonTypeChannels` both write that shape); `structuredReturnTypes` is
  keyed by the callee's full symbolId for a CLASS member (`Outer.Inner#method`)
  and by `` `${relPath}::${name}` `` for a MODULE-LEVEL def
  (`pythonModuleReturnKey`, bd tea-rags-mcp-1v12o.1.7). The channel re-keying
  that reconciles them with the kernel store's Ruby-shaped output is in
  `passes/python-type-channels.ts`, and the reasoning is in
  `domains/language/CLAUDE.md` → Mechanics. The field facts are ALSO written
  under a third, file-qualified key — what that address is for is a Resolver
  bullet above, and both writers share one reader so the two cannot disagree.
- **A module-level return fact names the FILE that declares it, and a stale
  bare-keyed row is silence.** A class member's owner disambiguates it; a
  top-level `def` has no owner, and the channel is folded run-global, so a bare
  `get_client` key made whichever of polar's six defs was walked first speak for
  all of them — `PolarSelfClient` against `IPGeolocationClient` and
  `GitHub[TokenAuthStrategy]`. Every reader asks `pythonImportBoundFile` which
  file the CALLER's own binding names and then reads that file's fact
  (`pythonModuleReturnType`); the caller's own file answers a same-file callee;
  no binding and no sole candidate is no fact. Pass-1 slices persist the channel
  (bd tea-rags-mcp-8qyax), and a slice written before this key change carries
  bare keys: the two shapes are disjoint, nothing asks for the bare one, and the
  run-global fold is key-agnostic — so an old row costs a fact, never a wrong
  one, until its file is re-walked. This is what retired E5.1a's provenance
  guard, which inferred the same thing from whether the narrowed file declared
  the returned class.
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
