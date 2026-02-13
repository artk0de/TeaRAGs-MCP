/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

import { CodeIndexer } from "../../../build/code/indexer.js";
import { getIndexerConfig, TEST_DIR } from "../config.mjs";
import { assert, createTestFile, hashContent, log, randomUUID, resources, section, skip, sleep } from "../helpers.mjs";

export async function testRubyASTChunking(qdrant, embeddings) {
  section("8b. Ruby AST Chunking (Rails Patterns)");

  const rubyTestDir = join(TEST_DIR, "ruby_test");
  await fs.mkdir(rubyTestDir, { recursive: true });

  // Rails-style Service object
  await createTestFile(
    rubyTestDir,
    "user_service.rb",
    `
# User service with typical Rails patterns
class UserService
  def initialize(repository)
    @repository = repository
  end

  def find_user(id)
    @repository.find(id)
  rescue ActiveRecord::RecordNotFound => e
    Rails.logger.error("User not found: #{id}")
    nil
  end

  def create_user(params)
    User.create!(params)
  rescue ActiveRecord::RecordInvalid => e
    { error: e.message }
  end

  def self.call(id)
    new(UserRepository.new).find_user(id)
  end
end
`,
  );

  // Rails Concern / Module
  await createTestFile(
    rubyTestDir,
    "authenticatable.rb",
    `
module Authenticatable
  extend ActiveSupport::Concern

  included do
    before_action :authenticate_user!
  end

  def authenticate_user!
    redirect_to login_path unless current_user
  end

  def current_user
    @current_user ||= User.find_by(id: session[:user_id])
  end
end
`,
  );

  // Ruby with lambdas and blocks
  await createTestFile(
    rubyTestDir,
    "validator.rb",
    `
class Validator
  RULES = {
    email: ->(value) { value.match?(/\\A[^@]+@[^@]+\\z/) },
    phone: lambda { |v| v.gsub(/\\D/, '').length == 10 }
  }

  def validate(data)
    data.each_pair do |key, value|
      rule = RULES[key]
      next unless rule
      yield key, rule.call(value)
    end
  end

  def transform(items)
    items.map { |item| process(item) }
         .select { |result| result.valid? }
         .group_by(&:category)
  end
end
`,
  );

  const indexer = new CodeIndexer(
    qdrant,
    embeddings,
    getIndexerConfig({
      supportedExtensions: [".rb"],
    }),
  );

  resources.trackIndexedPath(rubyTestDir);
  const stats = await indexer.indexCodebase(rubyTestDir, { forceReindex: true });
  assert(stats.filesIndexed === 3, `Ruby files indexed: ${stats.filesIndexed}`);
  assert(stats.chunksCreated > 0, `Ruby chunks created: ${stats.chunksCreated}`);

  // Test semantic search for Ruby patterns
  log("info", "Testing Ruby semantic search...");

  // Error handling
  const rescueResults = await indexer.searchCode(rubyTestDir, "error handling rescue exception");
  assert(rescueResults.length > 0, `Rescue/error handling found: ${rescueResults.length}`);

  // Service object pattern
  const serviceResults = await indexer.searchCode(rubyTestDir, "UserService find create");
  assert(serviceResults.length > 0, `Service object found: ${serviceResults.length}`);

  // Concern/module
  const concernResults = await indexer.searchCode(rubyTestDir, "Authenticatable authenticate current_user");
  assert(concernResults.length > 0, `Concern/module found: ${concernResults.length}`);

  // Lambda/proc
  const lambdaResults = await indexer.searchCode(rubyTestDir, "lambda validation rules");
  assert(lambdaResults.length > 0, `Lambda/validation found: ${lambdaResults.length}`);

  // Block operations
  const blockResults = await indexer.searchCode(rubyTestDir, "map select transform");
  assert(blockResults.length > 0, `Block operations found: ${blockResults.length}`);

  log("pass", "Ruby AST chunking works for Rails patterns");
}
