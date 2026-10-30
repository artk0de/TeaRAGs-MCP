/**
 * Eight Rails migrations copied from a production corpus (bd tea-rags-mcp-nplgm)
 * with the table names neutralised: `oauth_connections` and `oauth_documents`
 * stand for two vendor tables whose current state the fold must rebuild. The
 * operation text is verbatim — comments after `do |t|`, multi-line argument
 * lists, `safety_assured` wrappers, `up`/`down` pairs, `%i[]` arrays and
 * hash-valued `foreign_key:` / `index:` options are the shapes the fold reads.
 */

export const OAUTH_MIGRATIONS: Record<string, string> = {
  "db/migrate/20260728173319_create_oauth_connections.rb": `# frozen_string_literal: true

class CreateOauthConnections < ActiveRecord::Migration[7.2]
  def change
    create_table :oauth_connections do |t| # rubocop:disable Taxdome/RequireFirmIdInMigrations
      # Soft reference on purpose.
      t.references :firm, null: false, foreign_key: false, index: false
      t.references :actor, polymorphic: true, null: false, index: false

      t.string :encrypted_access_token
      t.datetime :access_expires_at

      t.string :encrypted_refresh_token
      t.datetime :refresh_expires_at

      t.integer :status, limit: 2, null: false, default: 0
      t.datetime :connected_at
      t.datetime :refreshed_at

      t.timestamps

      # One grant per member.
      t.index %i[firm_id actor_type actor_id], unique: true, name: 'idx_oauth_connections_on_firm_actor'
    end
  end
end
`,
  "db/migrate/20260731110423_create_oauth_documents.rb": `# frozen_string_literal: true

class CreateOauthDocuments < ActiveRecord::Migration[7.2]
  def change
    create_table :oauth_documents do |t| # rubocop:disable Taxdome/RequireFirmIdInMigrations
      t.references :firm, null: false, foreign_key: false, index: false

      t.references :tax_automation_document, null: false, index: false,
        foreign_key: {to_table: :tax_automations_documents, on_delete: :cascade}
      t.references :instead_entity, null: false, index: {name: 'idx_oauth_documents_on_entity'},
        foreign_key: {to_table: :oauth_entities}

      t.uuid :external_uuid
      t.string :path, null: false

      t.timestamps

      t.index :tax_automation_document_id, unique: true, name: 'idx_oauth_documents_on_ta_document'
      t.index %i[firm_id external_uuid], unique: true, where: 'external_uuid IS NOT NULL', name: 'idx_oauth_documents_on_firm_external'
    end
  end
end
`,
  "db/migrate/20260731110427_add_external_uuids_to_tax_automations.rb": `# frozen_string_literal: true

class AddExternalUuidsToTaxAutomations < ActiveRecord::Migration[7.2]
  def change
    add_column :tax_automations_firm_settings, :external_tenant_uuid, :uuid, if_not_exists: true
    add_column :oauth_connections, :external_uuid, :uuid, if_not_exists: true
  end
end
`,
  "db/migrate/20260731125304_rename_actor_to_creator_on_oauth_connections.rb": `# frozen_string_literal: true

class RenameActorToCreatorOnOauthConnections < ActiveRecord::Migration[7.2]
  def change
    # Safe despite the rename.
    safety_assured do
      rename_column :oauth_connections, :actor_type, :creator_type
      rename_column :oauth_connections, :actor_id, :creator_id
    end

    rename_index :oauth_connections,
      'idx_oauth_connections_on_firm_actor',
      'idx_oauth_connections_on_firm_creator'
  end
end
`,
  "db/migrate/20260806132558_make_oauth_connections_unique_per_firm.rb": `# frozen_string_literal: true

class MakeOauthConnectionsUniquePerFirm < ActiveRecord::Migration[7.2]
  disable_ddl_transaction!

  def change
    add_index :oauth_connections,
      :firm_id,
      unique: true,
      name: 'idx_oauth_connections_on_firm',
      algorithm: :concurrently,
      if_not_exists: true

    remove_index :oauth_connections,
      column: %i[firm_id creator_type creator_id],
      unique: true,
      name: 'idx_oauth_connections_on_firm_creator',
      algorithm: :concurrently,
      if_exists: true
  end
end
`,
  "db/migrate/20260807161554_add_code_verifier_to_oauth_connections.rb": `# frozen_string_literal: true

class AddCodeVerifierToOauthConnections < ActiveRecord::Migration[7.2]
  def change
    add_column :oauth_connections, :encrypted_code_verifier, :string, if_not_exists: true # rubocop:disable Rails/BulkChangeTable
    add_column :oauth_connections, :code_verifier_expires_at, :datetime, if_not_exists: true
  end
end
`,
  "db/migrate/20260915170006_add_external_uuid_index_to_oauth_documents.rb": `# frozen_string_literal: true

class AddExternalUuidIndexToOauthDocuments < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def up
    add_index :oauth_documents, :external_uuid,
      name: 'idx_oauth_documents_on_external_uuid',
      unique: true,
      where: 'external_uuid IS NOT NULL',
      algorithm: :concurrently,
      if_not_exists: true
  end

  def down
    remove_index :oauth_documents,
      name: 'idx_oauth_documents_on_external_uuid',
      algorithm: :concurrently,
      if_exists: true
  end
end
`,
  "db/migrate/20260922130328_add_refresh_expires_at_index_to_oauth_connections.rb": `# frozen_string_literal: true

class AddRefreshExpiresAtIndexToOauthConnections < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def up
    add_index :oauth_connections, :refresh_expires_at,
      name: 'idx_oauth_connections_on_refresh_expires_at',
      where: 'status = 1',
      algorithm: :concurrently,
      if_not_exists: true
  end

  def down
    remove_index :oauth_connections,
      name: 'idx_oauth_connections_on_refresh_expires_at',
      algorithm: :concurrently,
      if_exists: true
  end
end
`,
};
