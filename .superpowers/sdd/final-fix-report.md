# Final Fix Report — xlnub MUST-FIX: getCalleeEdges navigation filter regression test

## Test Added

**File:** `tests/core/adapters/duckdb/getcallee-edges-navfilter.test.ts`

Single `it` block inside:
```
describe("DuckDbGraphClient — getCalleeEdges navigation-visibility filter (xlnub)")
```

Follows the exact fixture pattern from `client-edge-kind.test.ts`:
- `DuckDbGraphClient` on a `mkdtempSync` temp DB
- `runMigrations(db, DATABASE_MIGRATIONS)` for full schema + migration 006 (edge_kind/confidence columns)
- `upsertFile` to insert three typed edges, then a raw `db.run(INSERT ... NULL, NULL)` for the legacy row

## Four Edge Cases Covered

| Edge | edge_kind | confidence | Expected | Reason |
|------|-----------|------------|----------|--------|
| `TargetDynamic#low` | `dynamic` | 0.5 | **EXCLUDED** | `NOT(dynamic AND 0.5<1)` = `NOT(true)` = false |
| `TargetDynamic#full` | `dynamic` | 1.0 | **INCLUDED** | `NOT(dynamic AND 1.0<1)` = `NOT(false)` = true |
| `TargetExact#method` | `exact` | 1.0 | **INCLUDED** | `NOT(false AND ...)` = true |
| `TargetLegacy#method` | NULL | NULL | **INCLUDED** | `NULL='dynamic'`=NULL; `COALESCE(NULL,1)=1≥1`→false; `NOT(NULL AND false)`=`NOT(false)`=true |

The legacy row was inserted via raw SQL because `upsertFile` coalesces to `'exact'`/`1.0` — there is no other way to create a genuine NULL edge_kind/confidence row through the normal write path.

## Non-Vacuity Proof

Before calling `getCalleeEdges`, the test queries the raw table and asserts:
```typescript
expect(rawTargets).toContain("TargetDynamic#low");
```

This confirms the excluded edge IS in the table. The test would FAIL if the
`AND NOT (edge_kind = 'dynamic' AND COALESCE(confidence, 1) < 1)` WHERE clause
were removed from `getCalleeEdges` — in that case `TargetDynamic#low` would
appear in the returned adjacency and `expect(targets).not.toContain(...)` would throw.

## GREEN Evidence

```
✓ tests/core/adapters/duckdb/getcallee-edges-navfilter.test.ts (1 test) 120ms
```

**DuckDB suite:** 161/161 passed (16 test files)
**tsc --noEmit:** no errors

## Files Changed

- **ADDED:** `tests/core/adapters/duckdb/getcallee-edges-navfilter.test.ts`
- **ADDED:** `.superpowers/sdd/final-fix-report.md` (this file)
- **No production code touched.**
