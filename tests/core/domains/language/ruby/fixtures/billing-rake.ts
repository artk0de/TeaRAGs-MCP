/**
 * A `.rake` file exercising every Rake DSL shape the chunker and the walker
 * read (bd tea-rags-mcp-k0602): a top-level helper def, nested namespaces,
 * `desc`, task argument forms, multitask, file, rule, and a top-level task.
 * Shared by the Rake chunking and walker tests so both read the same source.
 */

export const RAKE_PATH = "lib/tasks/billing.rake";

export const RAKE_FILE = `require "csv"
require_relative "../billing/syncer"

def sync_logger
  @sync_logger ||= ActiveSupport::Logger.new(Rails.root.join("log", "billing.log"))
end

namespace :billing do
  desc "Sync the billing invoices"
  task sync: :environment do
    invoices = Invoice.where(kind: "billing")
    invoices.each { |invoice| invoice.update!(synced_at: Time.current) }
    sync_logger.info("synced #{invoices.count}")
  end

  namespace :invoices do
    desc "Reconcile one invoice by id"
    task :reconcile, [:id] => :environment do |_t, args|
      Invoice.find(args[:id]).update!(synced_at: nil)
    end

    task :prune, [:a, :b] do |_t, args|
      Billing::Syncer.prune(args[:a], args[:b])
    end
  end

  task "export" do
    CSV.open("billing.csv", "w") { |csv| Invoice.find_each { |t| csv << [t.id] } }
  end

  multitask parallel_sync: %w[billing:sync billing:export]
  file "billing.csv" => ["billing:export"]
  rule ".json" => ".csv" do |t|
    Billing::Syncer.convert(t.source, t.name)
  end
end

desc "Run the full billing pipeline"
task :billing_all do
  Rake::Task["billing:sync"].invoke
  Rake::Task["billing:export"].invoke
end
`;
