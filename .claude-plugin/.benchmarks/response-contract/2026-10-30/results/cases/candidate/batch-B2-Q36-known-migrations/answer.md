After all three migrations, `report_exports` contains:

| Column | Type | Constraints/default |
|---|---|---|
| `id` | bigint | Rails-generated primary key |
| `tenant_id` | bigint | NOT NULL |
| `file_key` | string | NOT NULL |
| `status` | string | NOT NULL, defaults to `'queued'` |
| `completed_at` | datetime | Nullable |
| `created_at`, `updated_at` | datetime | Rails timestamps |

The final migration, [20261003110000_index_report_exports_for_tenant.rb](db/migrate/20261003110000_index_report_exports_for_tenant.rb), adds the non-unique composite index `idx_report_exports_tenant_status` on `(tenant_id, status)`, supporting efficient lookups by tenant and status.

Rolling back that migration removes only this index. The table, columns, defaults, and existing records remain intact.
