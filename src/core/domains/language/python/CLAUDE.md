# domains/language/python — walker monolith + one type-fact pass

## Invariants

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

## Mechanics

- **Two coordinate conventions live side by side.** `classFieldTypes` is keyed
  by class SHORT name with a bare member name (`walker/walker.ts:201` and the
  pass's `pythonTypeChannels` both write that shape); `structuredReturnTypes` is
  keyed by the callee's full symbolId (`Outer.Inner#method`). The channel
  re-keying that reconciles them with the kernel store's Ruby-shaped output is
  in `passes/python-type-channels.ts`, and the reasoning is in
  `domains/language/CLAUDE.md` → Mechanics.
