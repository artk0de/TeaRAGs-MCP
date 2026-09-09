# Python vertical — navigator

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
