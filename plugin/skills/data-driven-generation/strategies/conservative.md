# Conservative Strategy

**When:** file.ageDays "legacy" + chunk.commitCount "low" — old, untouched code.

## Approach

- Minimal changes — don't refactor, don't optimize
- Preserve signatures and return types exactly
- Don't move code between files
- Add new functionality alongside, not instead of, existing code
- Err on the side of duplication over abstraction
- Do not introduce new patterns into this area
- If adding a parameter, make it optional with backward-compatible default

## Why

Code untouched for 6+ months has undocumented assumptions. Callers depend on its exact behavior, including edge cases that aren't tested. Minimal change = minimal risk of breaking unknown consumers.
