After all three migrations, `report_exports` has:

| Column | Type | Constraints/default |
|---|---|---|
| `id` | bigint | Rails-generated primary key |
| `tenant_id` | bigint | NOT NULL |
| `file_key` | string | NOT NULL |
| `status` | string | NOT NULL, defaults to `'queued'` |
| `completed_at` | datetime | Nullable |
| `created_at`, `updated_at` | datetime | Rails timestamps |

The last migration, `20261003110000_index_report_exports_for_tenant.rb`, adds the composite index `idx_report_exports_tenant_status` on `(tenant_id, status)`, supporting efficient lookup by tenant and status.

Rolling it back removes only that index. The columns and stored data remain intact; queries still work but lose the index’s performance benefit.
