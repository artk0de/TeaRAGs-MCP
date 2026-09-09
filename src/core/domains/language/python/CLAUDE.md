# domains/language/python — navigator

## Resolver

- **`importText` is a persisted contract, not an internal string.** The walker's
  `collectPythonImports` emits `"a.b"`, `"a"` for `from a import b, c`, `"."`,
  `".a"`. The mapper, the external vocabulary and `importMatch` all parse it.
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
  the project DROPs rather than falling through to `importMatch` /
  `globalShortName`. It does NOT copy `localBinding`'s file-only fallback — that
  is measured for a DIRECT binding and unmeasured for a type reached by folding
  hops. `memberTypeOf` reads `classFieldTypes` (attribute) before
  `structuredReturnTypes` (return); their two key conventions are under
  Mechanics below. A `container` or `union` receiver yields nothing on purpose —
  `list[Foo]` types the list, not an element.
- **The vocabulary's stdlib check runs BEFORE the mapper.** The mapper probes
  the caller's ancestor directories first, so `import json` from
  `src/flask/tag.py` would otherwise land on flask's own
  `src/flask/json/__init__.py`. Which module the interpreter binds is a sys.path
  question no static root inference answers.
- **Chain order is a correctness argument, not a preference.** See the pass list
  in `resolver/python-resolver.ts`; the guards (`super`, `selfField`,
  `selfMember`, `localBinding`) DROP rather than fall through, which is what
  keeps `serializer.is_valid()` off an unrelated class.
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
