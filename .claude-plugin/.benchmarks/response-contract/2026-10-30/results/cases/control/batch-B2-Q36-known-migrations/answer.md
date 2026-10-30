After all three migrations, `report_exports` contains:

| Column | Type | Constraints/default |
|---|---|---|
| `id` | bigint | Rails-generated primary key |
| `tenant_id` | bigint | NOT NULL |
| `file_key` | string | NOT NULL |
| `created_at`, `updated_at` | datetime | Rails timestamps |
| `status` | string | NOT NULL, default `'queued'` |
| `completed_at` | datetime | Nullable |

The last migration, [20261003110000_index_report_exports_for_tenant.rb](db/migrate/20261003110000_index_report_exports_for_tenant.rb), adds the composite index `idx_report_exports_tenant_status` on `(tenant_id, status)`, enabling efficient lookup by tenant and status.

Rolling it back removes only that index. The columns and stored data remain; queries still work but lose this index’s performance benefit.
