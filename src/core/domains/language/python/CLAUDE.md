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
- **`PythonCallResolver` owns exactly ONE `PythonImportFileMapper`** and hands
  it to the chain factory, the cone locator and the external vocabulary. The
  memo is keyed by symbol-table identity and invalidated on `size()`, so a
  second instance is a second cold cache and a licence for two consumers to
  answer the same import differently.
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
- **Chain order is a correctness argument, not a preference.** Seven passes:
  `super`, `selfField`, `selfMember`, `localBinding`, `chainType`,
  `importedName`, `globalShortName`. See the pass list in
  `resolver/python-resolver.ts`; the guards (`super`, `selfField`, `selfMember`,
  `localBinding`) DROP rather than fall through, which is what keeps
  `serializer.is_valid()` off an unrelated class.
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

### Mechanics

- **Two coordinate conventions live side by side.** `classFieldTypes` is keyed
  by class SHORT name with a bare member name (`walker/walker.ts:201` and the
  pass's `pythonTypeChannels` both write that shape); `structuredReturnTypes` is
  keyed by the callee's full symbolId (`Outer.Inner#method`). The channel
  re-keying that reconciles them with the kernel store's Ruby-shaped output is
  in `passes/python-type-channels.ts`, and the reasoning is in
  `domains/language/CLAUDE.md` → Mechanics.
