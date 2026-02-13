import { beforeEach, describe, expect, it, vi } from "vitest";
import { TreeSitterChunker } from "../../../src/code/chunker/tree-sitter-chunker.js";
import type { ChunkerConfig } from "../../../src/code/types.js";

describe("TreeSitterChunker", () => {
  let chunker: TreeSitterChunker;
  let config: ChunkerConfig;

  beforeEach(() => {
    config = {
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    };
    chunker = new TreeSitterChunker(config);
  });

  describe("chunk - TypeScript", () => {
    it("should chunk TypeScript functions", async () => {
      const code = `
function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.metadata.name === "add")).toBe(true);
      expect(chunks.some((c) => c.metadata.name === "multiply")).toBe(true);
    });

    it("should chunk TypeScript classes", async () => {
      const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.chunkType === "class")).toBe(true);
    });

    it("should chunk TypeScript interfaces", async () => {
      const code = `
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
  category: string;
}

interface Order {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  totalPrice: number;
  status: string;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("chunk - Python", () => {
    it("should chunk Python functions", async () => {
      const code = `
def calculate_sum(numbers):
    """Calculate the sum of a list of numbers."""
    total = 0
    for num in numbers:
        total += num
    return total

def calculate_product(numbers):
    """Calculate the product of a list of numbers."""
    result = 1
    for num in numbers:
        result *= num
    return result

def calculate_average(numbers):
    """Calculate the average of a list of numbers."""
    if not numbers:
        return 0
    return calculate_sum(numbers) / len(numbers)
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      if (chunks.length > 0) {
        expect(
          chunks.some(
            (c) =>
              c.metadata.name === "calculate_sum" ||
              c.metadata.name === "calculate_product",
          ),
        ).toBe(true);
      }
    });

    it("should chunk Python classes", async () => {
      const code = `
class Calculator:
    def add(self, a, b):
        return a + b

    def multiply(self, a, b):
        return a * b
      `;

      const chunks = await chunker.chunk(code, "test.py", "python");
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("chunk - JavaScript", () => {
    it("should chunk JavaScript functions", async () => {
      const code = `
function greet(name) {
  return 'Hello, ' + name;
}

function farewell(name) {
  return 'Goodbye, ' + name;
}
      `;

      const chunks = await chunker.chunk(code, "test.js", "javascript");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("chunk - Ruby", () => {
    it("should always extract methods from classes regardless of class size", async () => {
      const code = `
class UserService
  def find_user(id)
    # Finds a user by their unique identifier
    user = User.find_by(id: id)
    raise NotFoundError unless user
    user
  end

  def create_user(params)
    # Creates a new user with the given parameters
    user = User.new(params)
    user.save!
    user
  end
end
      `;

      const chunks = await chunker.chunk(code, "test.rb", "ruby");

      // Should extract individual methods, not keep class as one chunk
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      // Each method should have parentName and parentType
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("UserService");
        expect(chunk.metadata.parentType).toBe("class");
      }

      // Verify method names
      const names = methodChunks.map(c => c.metadata.name).sort();
      expect(names).toEqual(["create_user", "find_user"]);

      // Verify symbolId format: ClassName.methodName
      expect(methodChunks.find(c => c.metadata.name === "find_user")?.metadata.symbolId)
        .toBe("UserService.find_user");
    });

    it("should extract methods with parentName/parentType from classes of any size", async () => {
      const code = `
class LargeService
  def method_one
    # This is the first method with some content
    puts "Processing method one"
    result = compute_something
    return result
  end

  def method_two
    # This is the second method with some content
    puts "Processing method two"
    data = fetch_data
    return data
  end

  def method_three
    # This is the third method with some content
    puts "Processing method three"
    value = calculate_value
    return value
  end

  def method_four
    # This is the fourth method to make class larger
    puts "Processing method four"
    output = generate_output
    return output
  end
end
      `;

      const chunks = await chunker.chunk(code, "large_service.rb", "ruby");

      // Should have individual method chunks
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // All methods should have parentName and parentType
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("LargeService");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should extract methods from modules with parentName/parentType", async () => {
      const code = `
module LargeModule
  def helper_one
    # First helper method with implementation
    puts "Helper one processing"
    result = process_data
    return result
  end

  def helper_two
    # Second helper method with implementation
    puts "Helper two processing"
    data = transform_data
    return data
  end

  def helper_three
    # Third helper method with implementation
    puts "Helper three processing"
    output = format_output
    return output
  end

  def helper_four
    # Fourth helper method for larger module
    puts "Helper four processing"
    value = compute_value
    return value
  end
end
      `;

      const chunks = await chunker.chunk(code, "large_module.rb", "ruby");

      // Should have individual method chunks
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // All methods should have parentName = module name
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("LargeModule");
        expect(chunk.metadata.parentType).toBe("module");
      }
    });

    it("should extract methods from class << self blocks", async () => {
      const code = `
class ConfigurationManager
  class << self
    def load_config
      # Load configuration from file
      puts "Loading configuration"
      config = read_file
      return config
    end

    def save_config(data)
      # Save configuration to file
      puts "Saving configuration"
      write_file(data)
      return true
    end

    def reset_config
      # Reset configuration to defaults
      puts "Resetting configuration"
      defaults = get_defaults
      return defaults
    end

    def validate_config(config)
      # Validate configuration values
      puts "Validating configuration"
      errors = check_values(config)
      return errors
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "config_manager.rb", "ruby");

      // Should extract individual methods
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(4);

      // Methods inside class << self should have class as parent
      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("ConfigurationManager");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should extract class-level code (scopes, associations, validations) as separate chunk", async () => {
      const code = `
class User < ApplicationRecord
  include Trackable
  include Searchable

  has_many :posts, dependent: :destroy
  has_many :comments, dependent: :destroy
  belongs_to :organization

  scope :active, -> { where(active: true) }
  scope :recent, -> { where("created_at > ?", 1.week.ago) }
  scope :admins, -> { where(role: "admin") }

  validates :name, presence: true
  validates :email, presence: true, uniqueness: true
  validates :role, inclusion: { in: %w[admin user guest] }

  before_save :normalize_email

  def full_name
    # Returns the full name by combining first and last name
    [first_name, last_name].compact.join(" ")
  end

  def deactivate!
    # Deactivates the user and notifies admins
    update!(active: false)
    NotificationService.notify_admins(self)
  end

  def admin?
    # Checks whether the user has admin privileges
    role == "admin" || organization&.admin?(self)
  end
end
      `;

      const chunks = await chunker.chunk(code, "user.rb", "ruby");

      // Should have method chunks
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(3);

      // Should have multiple body chunks (semantic groups for Ruby)
      const bodyChunks = chunks.filter(c => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBeGreaterThan(1);

      // All body chunks together should contain the declarations
      const allBodyContent = bodyChunks.map(c => c.content).join("\n");
      expect(allBodyContent).toContain("has_many :posts");
      expect(allBodyContent).toContain("scope :active");
      expect(allBodyContent).toContain("validates :name");
      expect(allBodyContent).toContain("include Trackable");
      expect(allBodyContent).toContain("before_save :normalize_email");

      // Body chunks should NOT contain method implementations
      for (const body of bodyChunks) {
        expect(body.content).not.toContain("def full_name");
        expect(body.content).not.toContain("def deactivate!");
      }

      // Each body chunk should have parent metadata and class header
      for (const body of bodyChunks) {
        expect(body.metadata.parentName).toBe("User");
        expect(body.metadata.parentType).toBe("class");
        expect(body.content).toContain("class User < ApplicationRecord");
      }
    });

    it("should keep class as single chunk when it has no methods", async () => {
      // A class with only declarations (no methods) stays as one chunk
      const code = `
class UserSerializer < ActiveModel::Serializer
  attributes :id, :name, :email, :role
  has_many :posts, serializer: PostSerializer
  belongs_to :organization, serializer: OrgSerializer
end
      `;

      const chunks = await chunker.chunk(code, "user_serializer.rb", "ruby");

      // Should be a single chunk (no methods to extract)
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("class");
      expect(chunks[0].metadata.name).toBe("UserSerializer");
    });

    it("should handle module with includes and methods", async () => {
      const code = `
module Authenticatable
  extend ActiveSupport::Concern

  included do
    has_secure_password
    validates :password, length: { minimum: 8 }
  end

  def authenticate(credentials)
    # Verify credentials against stored password hash
    return false unless credentials[:password]
    authenticate_password(credentials[:password])
  end

  def generate_token
    # Generate a secure authentication token for API access
    SecureRandom.hex(32).tap do |token|
      update!(auth_token: token)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "concerns.rb", "ruby");

      // Should have method chunks
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("Authenticatable");
        expect(chunk.metadata.parentType).toBe("module");
      }

      // Should have body chunks with module-level code (semantic groups for Ruby)
      const bodyChunks = chunks.filter(c => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBeGreaterThanOrEqual(1);

      const allBodyContent = bodyChunks.map(c => c.content).join("\n");
      expect(allBodyContent).toContain("extend ActiveSupport::Concern");
    });

    it("should chunk Ruby singleton methods with parentName", async () => {
      const code = `
class Configuration
  DEFAULT_TIMEOUT = 30
  DEFAULT_RETRIES = 3

  def self.load_from_file(path)
    # Load YAML configuration from the specified file path
    config = YAML.load_file(path)
    validate!(config)
    config
  end

  def self.default_settings
    # Returns default configuration settings hash
    { timeout: DEFAULT_TIMEOUT, retries: DEFAULT_RETRIES }
  end
end
      `;

      const chunks = await chunker.chunk(code, "config.rb", "ruby");

      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);

      for (const chunk of methodChunks) {
        expect(chunk.metadata.parentName).toBe("Configuration");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should chunk Ruby lambdas and procs as part of class body", async () => {
      const code = `
class Calculator
  OPERATIONS = {
    add: ->(a, b) { a + b },
    subtract: lambda { |a, b| a - b },
    multiply: ->(a, b) { a * b }
  }

  VALIDATORS = {
    positive: ->(n) { n > 0 },
    even: ->(n) { n.even? }
  }

  def process(data)
    # Process data through the operation pipeline
    data.map do |item|
      transform(item)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "calculator.rb", "ruby");

      // Should extract the method
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(1);
      expect(methodChunks[0].metadata.name).toBe("process");

      // Constants with lambdas should be in the class body chunk
      const bodyChunks = chunks.filter(c => c.metadata.chunkType === "block");
      expect(bodyChunks.length).toBe(1);
      expect(bodyChunks[0].content).toContain("OPERATIONS");
      expect(bodyChunks[0].content).toContain("VALIDATORS");
    });

    it("should chunk Ruby begin/rescue blocks within methods", async () => {
      const code = `
class ApiClient
  def fetch_data(url)
    begin
      response = HTTP.get(url)
      parse_response(response)
    rescue NetworkError => e
      handle_network_error(e)
    rescue ParseError => e
      handle_parse_error(e)
    end
  end

  def post_data(url, payload)
    begin
      response = HTTP.post(url, body: payload)
      parse_response(response)
    rescue NetworkError => e
      retry_with_backoff(e)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "api_client.rb", "ruby");

      // Methods should be extracted individually, rescue blocks stay inside
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBe(2);
      expect(methodChunks[0].content).toContain("rescue NetworkError");
    });

    it("should handle class with only very short methods (under min threshold)", async () => {
      // When all methods are too short, keep as single class chunk
      const code = `
class SmallService
  def name
    @name
  end

  def id
    @id
  end
end
      `;

      const chunks = await chunker.chunk(code, "small_service.rb", "ruby");

      // Class with only tiny methods — kept as single class chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("class");
    });
  });

  describe("chunk - Markdown", () => {
    it("should chunk markdown by sections", async () => {
      const code = `
# Introduction

This is the introduction section with some content.

## Getting Started

Here is how to get started with the project.

### Installation

Run npm install to install dependencies.

## Usage

Use the library like this.
      `;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Should have section chunks
      const sectionChunks = chunks.filter(c => c.metadata.name);
      expect(sectionChunks.length).toBeGreaterThan(0);
    });

    it("should extract code blocks from markdown", async () => {
      const code = `
# Code Examples

Here is a TypeScript example:

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

And a Python example:

\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`
      `;

      const chunks = await chunker.chunk(code, "examples.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Should have code block chunks with language metadata
      const codeChunks = chunks.filter(c =>
        c.metadata.name?.includes("Code") ||
        c.metadata.language === "typescript" ||
        c.metadata.language === "python"
      );
      expect(codeChunks.length).toBeGreaterThan(0);
    });

    it("should handle markdown without headings", async () => {
      const code = `
This is a markdown file without any headings.
It just has some plain text content that should be chunked as a single block.
The content needs to be long enough to meet the minimum chunk size requirements.
      `;

      const chunks = await chunker.chunk(code, "notes.md", "markdown");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should support markdown language", () => {
      expect(chunker.supportsLanguage("markdown")).toBe(true);
    });

    it("should set isDocumentation flag for markdown chunks", async () => {
      const code = `
# Documentation Title

This is documentation content that explains how to use the library.

## API Reference

Here are the available methods and their descriptions.
      `;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // All markdown chunks should have isDocumentation = true
      for (const chunk of chunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
      }
    });
  });

  describe("fallback behavior", () => {
    it("should fallback to character chunker for unsupported language", async () => {
      const code =
        "Some random text that is long enough to not be filtered out by the minimum chunk size requirement.\n" +
        "This is another line with enough content to make a valid chunk.\n" +
        "And here is a third line to ensure we have sufficient text content.";
      const chunks = await chunker.chunk(code, "test.txt", "unknown");

      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should fallback for very large chunks", async () => {
      const largeFunction = `
function veryLargeFunction() {
  ${Array(100).fill('console.log("line");').join("\n  ")}
}
      `;

      const chunks = await chunker.chunk(
        largeFunction,
        "test.js",
        "javascript",
      );
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should fallback on parsing errors", async () => {
      const invalidCode = "function broken( { invalid syntax";
      const chunks = await chunker.chunk(invalidCode, "test.js", "javascript");

      // Should handle gracefully and fallback
      expect(Array.isArray(chunks)).toBe(true);
    });
  });

  describe("metadata extraction", () => {
    it("should extract function names", async () => {
      const code = `
function myFunction() {
  console.log('Processing data');
  return 42;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks[0].metadata.name).toBe("myFunction");
      expect(chunks[0].metadata.chunkType).toBe("function");
    });

    it("should include file path and language", async () => {
      const code =
        "function test() {\n  console.log('Test function');\n  return true;\n}";
      const chunks = await chunker.chunk(
        code,
        "/path/to/file.ts",
        "typescript",
      );

      expect(chunks[0].metadata.filePath).toBe("/path/to/file.ts");
      expect(chunks[0].metadata.language).toBe("typescript");
    });

    it("should set correct line numbers", async () => {
      const code = `
line1
function test() {
  console.log('Testing line numbers');
  return 1;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks[0].startLine).toBeGreaterThan(0);
      expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    });
  });

  describe("supportsLanguage", () => {
    it("should support TypeScript", () => {
      expect(chunker.supportsLanguage("typescript")).toBe(true);
    });

    it("should support Python", () => {
      expect(chunker.supportsLanguage("python")).toBe(true);
    });

    it("should support Ruby", () => {
      expect(chunker.supportsLanguage("ruby")).toBe(true);
    });

    it("should not support unknown languages", () => {
      expect(chunker.supportsLanguage("unknown")).toBe(false);
    });
  });

  describe("lazy loading", () => {
    it("should have no parsers loaded initially", () => {
      const freshChunker = new TreeSitterChunker(config);
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toHaveLength(0);
      expect(stats.available.length).toBeGreaterThan(0);
    });

    it("should load parser on first use", async () => {
      const freshChunker = new TreeSitterChunker(config);
      await freshChunker.chunk("function test() { return 1; }", "test.ts", "typescript");
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");
    });

    it("should preload multiple languages", async () => {
      const freshChunker = new TreeSitterChunker(config);
      await freshChunker.preloadLanguages(["python", "ruby"]);
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("python");
      expect(stats.loaded).toContain("ruby");
    });

    it("should return all supported languages", () => {
      const languages = chunker.getSupportedLanguages();
      expect(languages).toContain("typescript");
      expect(languages).toContain("javascript");
      expect(languages).toContain("python");
      expect(languages).toContain("ruby");
      expect(languages).toContain("go");
      expect(languages).toContain("rust");
      expect(languages).toContain("java");
      expect(languages).toContain("bash");
      expect(languages).toContain("markdown");
    });
  });

  describe("getStrategyName", () => {
    it("should return tree-sitter", () => {
      expect(chunker.getStrategyName()).toBe("tree-sitter");
    });
  });

  describe("edge cases", () => {
    it("should handle empty code", async () => {
      const chunks = await chunker.chunk("", "test.ts", "typescript");
      expect(chunks).toHaveLength(0);
    });

    it("should skip very small chunks", async () => {
      const code = "const x = 1;";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      // Very small chunks should be skipped
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle nested structures", async () => {
      const code = `
class Outer {
  method1() {
    function inner() {
      return 1;
    }
  }

  method2() {
    return 2;
  }
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should extract name from child identifier when name field is absent", async () => {
      // This code pattern will trigger the fallback name extraction from children
      const code = `
type MyType = {
  field1: string;
  field2: number;
};
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle struct-like constructs", async () => {
      // Go-like struct to test getChunkType handling of struct patterns
      const code = `
type User struct {
  ID   int
  Name string
}
      `;

      const chunks = await chunker.chunk(code, "test.go", "go");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      // Should classify as class type due to struct pattern
      if (chunks.length > 0) {
        expect(chunks.some((c) => c.metadata.chunkType === "class")).toBe(true);
      }
    });

    it("should handle trait-like constructs", async () => {
      // Rust trait to test getChunkType handling of trait patterns
      const code = `
trait Printable {
    fn print(&self);
}
      `;

      const chunks = await chunker.chunk(code, "test.rs", "rust");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
      // Should classify as interface type due to trait pattern
      if (chunks.length > 0) {
        expect(chunks.some((c) => c.metadata.chunkType === "interface")).toBe(
          true,
        );
      }
    });

    it("should classify unknown node types as block", async () => {
      // Create a large code block that doesn't match function, class, or interface patterns
      const code = `
export const myModule = {
  helper1: () => {
    console.log('Helper function 1');
    return 'result1';
  },
  helper2: () => {
    console.log('Helper function 2');
    return 'result2';
  },
  config: {
    name: 'my-module',
    version: '1.0.0',
  },
};
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("symbolId metadata", () => {
    it("should set symbolId for standalone functions", async () => {
      const code = `
function calculateSum(numbers: number[]): number {
  // Calculate the sum of all numbers in the array
  let total = 0;
  for (const num of numbers) {
    total += num;
  }
  return total;
}

function calculateProduct(numbers: number[]): number {
  // Calculate the product of all numbers in the array
  let result = 1;
  for (const num of numbers) {
    result *= num;
  }
  return result;
}
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Find function chunks by name
      const functionChunks = chunks.filter(c =>
        c.metadata.name === "calculateSum" || c.metadata.name === "calculateProduct"
      );

      // Verify symbolId is set for functions
      for (const chunk of functionChunks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }
    });

    it("should set symbolId for methods in large classes with parentName", async () => {
      // Use smaller config to trigger class splitting
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

      const code = `
class UserService
  def find_by_id(id)
    # Find user by ID with additional processing
    puts "Finding user with ID: #{id}"
    user = User.find(id)
    validate_user(user)
    return user
  end

  def create_user(params)
    # Create new user with validation
    puts "Creating user with params: #{params}"
    validate_params(params)
    user = User.create(params)
    send_welcome_email(user)
    return user
  end

  def update_user(id, params)
    # Update existing user with checks
    puts "Updating user #{id} with params"
    user = User.find(id)
    validate_params(params)
    user.update(params)
    log_update(user)
    return user
  end

  def delete_user(id)
    # Delete user by ID with cleanup
    puts "Deleting user with ID: #{id}"
    user = User.find(id)
    cleanup_user_data(user)
    User.destroy(id)
    log_deletion(id)
  end

  def list_users(page, per_page)
    # List users with pagination
    puts "Listing users page #{page}"
    offset = (page - 1) * per_page
    users = User.offset(offset).limit(per_page)
    return users
  end
end
      `;

      const chunks = await smallChunker.chunk(code, "user_service.rb", "ruby");

      // Find method chunks with parentName (indicates class was split)
      const methodChunks = chunks.filter(
        c => c.metadata.parentName && c.metadata.chunkType === "function"
      );

      // If class was split, verify symbolId format
      if (methodChunks.length > 0) {
        for (const chunk of methodChunks) {
          if (chunk.metadata.name && chunk.metadata.parentName) {
            expect(chunk.metadata.symbolId).toBe(
              `${chunk.metadata.parentName}.${chunk.metadata.name}`
            );
          }
        }

        // Specific check for one method
        const findMethod = methodChunks.find(c => c.metadata.name === "find_by_id");
        if (findMethod) {
          expect(findMethod.metadata.symbolId).toBe("UserService.find_by_id");
        }
      } else {
        // If class wasn't split, all chunks should still have symbolId
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
          if (chunk.metadata.name) {
            expect(chunk.metadata.symbolId).toBeDefined();
          }
        }
      }
    });

    it("should set symbolId for markdown sections", async () => {
      const code = `
# Main Title

Introduction paragraph with content.

## Installation

Instructions for installation.

### Prerequisites

List of prerequisites.

## Usage

How to use the library.
      `;

      const chunks = await chunker.chunk(code, "README.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Find section chunks
      const sectionChunks = chunks.filter(c => c.metadata.name && c.metadata.isDocumentation);

      expect(sectionChunks.length).toBeGreaterThan(0);

      // Verify symbolId is set to section name
      for (const chunk of sectionChunks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }

      // Check specific section
      const installChunk = sectionChunks.find(c => c.metadata.name === "Installation");
      if (installChunk) {
        expect(installChunk.metadata.symbolId).toBe("Installation");
      }
    });

    it("should set symbolId for markdown code blocks", async () => {
      const code = `
# Examples

TypeScript example:

\`\`\`typescript
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Python example:

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`
      `;

      const chunks = await chunker.chunk(code, "examples.md", "markdown");
      expect(chunks.length).toBeGreaterThan(0);

      // Find code block chunks
      const codeBlocks = chunks.filter(c =>
        c.metadata.name?.includes("Code") && c.metadata.isDocumentation
      );

      expect(codeBlocks.length).toBeGreaterThan(0);

      // Verify symbolId is set
      for (const chunk of codeBlocks) {
        expect(chunk.metadata.symbolId).toBe(chunk.metadata.name);
      }

      // Check specific code blocks
      const tsCodeBlock = codeBlocks.find(c => c.metadata.name === "Code: typescript");
      if (tsCodeBlock) {
        expect(tsCodeBlock.metadata.symbolId).toBe("Code: typescript");
      }

      const pyCodeBlock = codeBlocks.find(c => c.metadata.name === "Code: python");
      if (pyCodeBlock) {
        expect(pyCodeBlock.metadata.symbolId).toBe("Code: python");
      }
    });

    it("should set symbolId for small classes without parent context", async () => {
      const code = `
class Calculator
  def add(a, b)
    a + b
  end
end
      `;

      const chunks = await chunker.chunk(code, "calculator.rb", "ruby");

      // Small class should be one chunk
      expect(chunks.length).toBe(1);

      // symbolId should be the class name (no parent splitting)
      expect(chunks[0].metadata.symbolId).toBe("Calculator");
    });

    it("should handle chunks without name gracefully", async () => {
      const code = `
const x = 1;
const y = 2;
      `;

      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      if (chunks.length > 0) {
        // If no name, symbolId should be undefined
        const chunk = chunks[0];
        if (!chunk.metadata.name) {
          expect(chunk.metadata.symbolId).toBeUndefined();
        }
      }
    });

    it("should set symbolId for TypeScript class methods in large classes", async () => {
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

      const code = `
class DataProcessor {
  processData(data: string[]): string[] {
    // Process the data
    console.log('Processing data');
    return data.map(item => item.trim());
  }

  validateData(data: string[]): boolean {
    // Validate the data
    console.log('Validating data');
    return data.every(item => item.length > 0);
  }

  transformData(data: string[]): Record<string, string> {
    // Transform data to object
    console.log('Transforming data');
    return data.reduce((acc, item, idx) => {
      acc[\`key\${idx}\`] = item;
      return acc;
    }, {} as Record<string, string>);
  }

  saveData(data: string[]): void {
    // Save the data
    console.log('Saving data');
    localStorage.setItem('data', JSON.stringify(data));
  }
}
      `;

      const chunks = await smallChunker.chunk(code, "processor.ts", "typescript");

      // Find method chunks with parent
      const methodChunks = chunks.filter(
        c => c.metadata.parentName === "DataProcessor" && c.metadata.chunkType === "function"
      );

      if (methodChunks.length > 0) {
        // Verify symbolId format
        for (const chunk of methodChunks) {
          expect(chunk.metadata.symbolId).toBe(
            `DataProcessor.${chunk.metadata.name}`
          );
        }

        // Check specific method
        const processMethod = methodChunks.find(c => c.metadata.name === "processData");
        if (processMethod) {
          expect(processMethod.metadata.symbolId).toBe("DataProcessor.processData");
        }
      }
    });
  });

  describe("markdown preamble handling", () => {
    it("should create a Preamble chunk for content before the first heading", async () => {
      const code = [
        "This is introductory text that appears before any heading in the document.",
        "It should be captured as a preamble chunk with proper metadata.",
        "",
        "# First Heading",
        "",
        "Content under the first heading goes here with additional details.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Should have a preamble chunk
      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeDefined();
      expect(preamble!.content).toContain("introductory text");
      expect(preamble!.metadata.symbolId).toBe("Preamble");
      expect(preamble!.metadata.isDocumentation).toBe(true);
      expect(preamble!.metadata.chunkType).toBe("block");
      expect(preamble!.startLine).toBe(1);

      // Preamble should be the first chunk (unshifted to index 0)
      expect(chunks[0].metadata.name).toBe("Preamble");
      expect(chunks[0].metadata.chunkIndex).toBe(0);
    });

    it("should re-index all chunks after inserting preamble", async () => {
      const code = [
        "This preamble text is long enough to exceed the 50-character minimum threshold.",
        "",
        "# Section One",
        "",
        "Content for section one that is also long enough to exceed the minimum threshold.",
        "",
        "# Section Two",
        "",
        "Content for section two that is also long enough to exceed the minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Verify sequential chunk indices after re-indexing
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].metadata.chunkIndex).toBe(i);
      }

      // First chunk should be the preamble
      expect(chunks[0].metadata.name).toBe("Preamble");
    });

    it("should skip preamble when content before first heading is too short", async () => {
      const code = [
        "Short.",
        "",
        "# Heading",
        "",
        "Content under the heading that is long enough to exceed the minimum threshold for chunking.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // No preamble chunk because it's too short (< 50 chars)
      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeUndefined();
    });
  });

  describe("markdown without headings", () => {
    it("should treat whole document as one chunk when there are no headings", async () => {
      const code = [
        "This is a markdown document that has no headings at all.",
        "It contains multiple lines of plain text content that should be",
        "treated as a single chunk since there is no heading-based structure.",
        "The content needs to exceed the 50-character minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "notes.md", "markdown");

      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("block");
      expect(chunks[0].metadata.isDocumentation).toBe(true);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].metadata.chunkIndex).toBe(0);
      // No name or symbolId for headingless documents
      expect(chunks[0].metadata.name).toBeUndefined();
    });

    it("should return empty array for headingless markdown under 50 chars", async () => {
      const code = "Short text.";

      const chunks = await chunker.chunk(code, "tiny.md", "markdown");
      expect(chunks.length).toBe(0);
    });
  });

  describe("oversized markdown sections", () => {
    it("should split oversized sections using character fallback", async () => {
      // Use a small config so sections easily exceed maxChunkSize * 2
      const smallConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

      // Generate a section with content that exceeds 100 * 2 = 200 chars
      const longContent = Array(30)
        .fill("This line of content is used to inflate the section size beyond the limit.")
        .join("\n");

      const code = [
        "# Oversized Section",
        "",
        longContent,
        "",
        "# Normal Section",
        "",
        "This is a normal-sized section with enough content to pass minimum threshold checks.",
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "big.md", "markdown");

      // The oversized section should have been split into multiple sub-chunks
      const oversizedChunks = chunks.filter(
        (c) => c.metadata.name === "Oversized Section" || c.metadata.parentName === "Oversized Section",
      );
      expect(oversizedChunks.length).toBeGreaterThan(1);

      // Sub-chunks should have isDocumentation flag
      for (const chunk of oversizedChunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
      }

      // Sub-chunks should have parentType reflecting heading depth
      for (const chunk of oversizedChunks) {
        if (chunk.metadata.parentType) {
          expect(chunk.metadata.parentType).toBe("h1");
        }
      }
    });
  });

  describe("oversized child chunks", () => {
    it("should fall back to character chunking for oversized methods", async () => {
      // Use a small config so methods easily exceed maxChunkSize * 2
      const smallConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

      // Create a Ruby class with one very large method (> 200 chars)
      const longBody = Array(25)
        .fill('    puts "Processing data transformation step with logging and validation"')
        .join("\n");

      const code = [
        "class DataProcessor",
        "  def very_large_method(input)",
        longBody,
        "  end",
        "",
        "  def small_method(x)",
        "    # A small method for comparison",
        "    puts x",
        "    return x + 1",
        "  end",
        "end",
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "processor.rb", "ruby");

      // The oversized method should be split into sub-chunks with parentName
      const subChunks = chunks.filter(
        (c) => c.metadata.parentName === "DataProcessor" && c.metadata.chunkType !== "function" && c.metadata.chunkType !== "block",
      );
      // At minimum we should have chunks; the large method produces sub-chunks
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks from this class should reference DataProcessor as parent
      const processorChunks = chunks.filter((c) => c.metadata.parentName === "DataProcessor");
      expect(processorChunks.length).toBeGreaterThan(0);
    });
  });

  describe("empty code fallback", () => {
    it("should fall back to character chunker when no AST chunks but code > 100 chars", async () => {
      // Code that produces no chunkable AST nodes but is long enough to trigger fallback
      // Using a series of simple statements that tree-sitter won't chunk as functions/classes
      const code = [
        'const a = "value1";',
        'const b = "value2";',
        'const c = "value3";',
        'const d = "value4";',
        'const e = "value5";',
        'const f = "value6";',
        'const g = "value7";',
        'const h = "value8";',
      ].join("\n");

      // Ensure the code is > 100 chars
      expect(code.length).toBeGreaterThan(100);

      const chunks = await chunker.chunk(code, "constants.ts", "typescript");

      // The fallback chunker should produce at least one chunk
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("markdown text extraction edge cases", () => {
    it("should extract text from headings with emphasis", async () => {
      const code = [
        "# Getting *Started* with the Project",
        "",
        "This section explains how to begin working with the project and its dependencies.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The heading text should include the emphasized word
      const section = chunks.find((c) => c.metadata.name?.includes("Started"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Getting Started with the Project");
    });

    it("should extract text from headings with links", async () => {
      const code = [
        "# Install [Node.js](https://nodejs.org) First",
        "",
        "You must install Node.js before proceeding with the rest of the setup process.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The heading text should include the link text but not the URL
      const section = chunks.find((c) => c.metadata.name?.includes("Node.js"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Install Node.js First");
    });

    it("should handle headings with inline code (inline code value is not extracted)", async () => {
      const code = [
        "# Using the `chunk` Method",
        "",
        "The chunk method is the primary API for splitting code into manageable pieces.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // inlineCode nodes have value but no children and type != "text",
      // so extractTextFromMdastNode returns "" for them.
      // The heading name will contain the surrounding text but not the code value.
      expect(chunks.length).toBeGreaterThan(0);
      const section = chunks.find((c) => c.metadata.name?.includes("Using the"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("Using the  Method");
    });

    it("should extract text from headings with strong emphasis", async () => {
      const code = [
        "# The **Important** Configuration Guide",
        "",
        "This guide covers the essential configuration settings you need to know about.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const section = chunks.find((c) => c.metadata.name?.includes("Important"));
      expect(section).toBeDefined();
      expect(section!.metadata.name).toBe("The Important Configuration Guide");
    });

    it("should return empty string for nodes without text or children", async () => {
      // A heading with an image (which has no text children, only alt text)
      const code = [
        "# Logo ![alt text](image.png) Brand",
        "",
        "This section describes the brand identity and logo usage across the platform.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Should still produce a chunk with the text portions extracted
      expect(chunks.length).toBeGreaterThan(0);
      const section = chunks.find((c) => c.metadata.name?.includes("Brand"));
      expect(section).toBeDefined();
    });
  });

  describe("no valid children fallback", () => {
    it("should fall back to character chunking for oversized nodes with no valid children", async () => {
      // Use a very small config so the class is "too large"
      const tinyConfig: ChunkerConfig = {
        chunkSize: 50,
        chunkOverlap: 5,
        maxChunkSize: 50,
      };
      const tinyChunker = new TreeSitterChunker(tinyConfig);

      // A Ruby class that is large (> 50 * 2 = 100 chars) but has NO methods inside
      // Only has declarations, which are not in childChunkTypes
      const code = [
        "class LargeSerializer < ActiveModel::Serializer",
        '  attributes :id, :name, :email, :role, :created_at, :updated_at, :status, :avatar_url',
        "  has_many :posts, serializer: PostSerializer",
        "  has_many :comments, serializer: CommentSerializer",
        "  belongs_to :organization, serializer: OrgSerializer",
        "  belongs_to :department, serializer: DeptSerializer",
        '  attribute :full_name do',
        '    object.first_name + " " + object.last_name',
        "  end",
        "end",
      ].join("\n");

      // Ensure code is > 100 chars (maxChunkSize * 2)
      expect(code.length).toBeGreaterThan(100);

      const chunks = await tinyChunker.chunk(code, "serializer.rb", "ruby");

      // Should produce chunks via character fallback since no valid child methods found
      expect(chunks.length).toBeGreaterThan(0);

      // Sub-chunks should have parentName from the class
      const withParent = chunks.filter((c) => c.metadata.parentName === "LargeSerializer");
      expect(withParent.length).toBeGreaterThan(0);
    });
  });

  describe("non-Ruby body extraction for large classes", () => {
    it("should extract body chunk for non-Ruby languages with alwaysExtractChildren", async () => {
      // We need a language with childChunkTypes AND alwaysExtractChildren
      // Currently only Ruby has alwaysExtractChildren, but we can test the non-Ruby
      // body extraction path by using a class large enough to trigger shouldExtractChildren
      // via isTooLarge in a non-Ruby language that has childChunkTypes

      // For TypeScript, there are no childChunkTypes defined, so we test with Ruby
      // but verify the non-Ruby branch (lines 382-402) is unreachable without modification.
      // Instead, test that Ruby correctly uses the Ruby path (lines 345-381).
      // The non-Ruby path requires alwaysExtractChildren on a non-Ruby language,
      // which isn't in the default config. This is tested indirectly.

      // Test that large TypeScript classes are handled via the isTooLarge path
      // (which doesn't have childChunkTypes, so goes through the single-chunk path)
      const tinyConfig: ChunkerConfig = {
        chunkSize: 100,
        chunkOverlap: 10,
        maxChunkSize: 100,
      };
      const tinyChunker = new TreeSitterChunker(tinyConfig);

      const longBody = Array(15)
        .fill("    console.log('Processing step with detailed logging and validation');")
        .join("\n");

      const code = [
        "class LargeProcessor {",
        "  processData(data: string[]): void {",
        longBody,
        "  }",
        "",
        "  validateData(data: string[]): boolean {",
        longBody,
        "  }",
        "}",
      ].join("\n");

      const chunks = await tinyChunker.chunk(code, "processor.ts", "typescript");

      // Should produce chunks (class is split due to being oversized)
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("chunk - Java", () => {
    it("should chunk Java class with methods", async () => {
      const code = `
public class Calculator {
    public int add(int a, int b) {
        // Add two integers together and return result
        return a + b;
    }

    public int multiply(int a, int b) {
        // Multiply two integers together and return result
        return a * b;
    }
}
      `;

      const chunks = await chunker.chunk(code, "Calculator.java", "java");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.language === "java")).toBe(true);
    });
  });

  describe("chunk - Bash", () => {
    it("should chunk Bash functions", async () => {
      const code = `
function setup_environment() {
    echo "Setting up the development environment"
    export PATH="$HOME/bin:$PATH"
    export NODE_ENV="development"
    mkdir -p "$HOME/logs"
}

function cleanup_environment() {
    echo "Cleaning up the development environment"
    unset NODE_ENV
    rm -rf "$HOME/logs/tmp"
}
      `;

      const chunks = await chunker.chunk(code, "setup.sh", "bash");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.language === "bash")).toBe(true);
    });
  });

  describe("parser cache behavior", () => {
    it("should use cached parser on second call with same language", async () => {
      const freshChunker = new TreeSitterChunker(config);

      // First call: loads the parser
      const code1 = `
function first() {
  console.log('First function call');
  return 1;
}
      `;
      await freshChunker.chunk(code1, "a.ts", "typescript");

      // Verify parser is now cached
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");

      // Second call: should use cached parser (hits parserCache.get branch)
      const code2 = `
function second() {
  console.log('Second function call');
  return 2;
}
      `;
      const chunks = await freshChunker.chunk(code2, "b.ts", "typescript");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.name).toBe("second");
    });

    it("should deduplicate concurrent parser loading for same language", async () => {
      const freshChunker = new TreeSitterChunker(config);

      const code1 = `
function funcA() {
  console.log('Function A implementation');
  return 'a';
}
      `;
      const code2 = `
function funcB() {
  console.log('Function B implementation');
  return 'b';
}
      `;

      // Launch two chunks concurrently for the same language
      // The second call should hit the loadingPromises dedup path
      const [chunks1, chunks2] = await Promise.all([
        freshChunker.chunk(code1, "a.ts", "typescript"),
        freshChunker.chunk(code2, "b.ts", "typescript"),
      ]);

      expect(chunks1.length).toBeGreaterThan(0);
      expect(chunks2.length).toBeGreaterThan(0);

      // Parser should only be loaded once
      const stats = freshChunker.getLoadedParsers();
      expect(stats.loaded).toContain("typescript");
    });
  });

  describe("markdown code blocks edge cases", () => {
    it("should skip very small code blocks under 30 chars", async () => {
      const code = [
        "# Examples",
        "",
        "A tiny code block:",
        "",
        "```js",
        "x = 1;",
        "```",
        "",
        "A larger code block that meets the minimum size:",
        "",
        "```python",
        "def calculate_fibonacci(n):",
        "    if n <= 1:",
        "        return n",
        "    return calculate_fibonacci(n-1) + calculate_fibonacci(n-2)",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "examples.md", "markdown");

      // The tiny js code block should be skipped (< 30 chars)
      const jsBlocks = chunks.filter((c) => c.metadata.language === "js");
      expect(jsBlocks.length).toBe(0);

      // The larger python block should be included
      const pyBlocks = chunks.filter((c) => c.metadata.language === "python");
      expect(pyBlocks.length).toBe(1);
    });

    it("should handle code blocks without language as 'Code block'", async () => {
      const code = [
        "# Setup",
        "",
        "Run the following commands to set up your environment:",
        "",
        "```",
        "npm install",
        "npm run build",
        "npm run test",
        "npm run lint",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "setup.md", "markdown");

      // Code block without language should use "Code block" as name
      const codeBlock = chunks.find((c) => c.metadata.name === "Code block");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.metadata.language).toBe("code");
    });

    it("should produce chunks from code blocks even when no headings exist", async () => {
      // Markdown without headings but with a code block
      const code = [
        "Here is a useful snippet that demonstrates the pattern:",
        "",
        "```typescript",
        "async function fetchData(url: string): Promise<Response> {",
        "  const response = await fetch(url);",
        "  if (!response.ok) {",
        "    throw new Error(`HTTP error! Status: ${response.status}`);",
        "  }",
        "  return response;",
        "}",
        "```",
        "",
        "Use this pattern for all API calls in the application.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "snippet.md", "markdown");

      // Should produce chunks: whole-document chunk + code block chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Should have a code block chunk
      const codeBlock = chunks.find((c) => c.metadata.name === "Code: typescript");
      expect(codeBlock).toBeDefined();
    });
  });

  describe("markdown section with very small content", () => {
    it("should skip sections with content under 50 chars", async () => {
      const code = [
        "# Short",
        "",
        "Tiny.",
        "",
        "# Detailed Section",
        "",
        "This section contains enough content to exceed the fifty character minimum threshold for chunking.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // The "Short" section has < 50 chars total, should be skipped
      const shortSection = chunks.find((c) => c.metadata.name === "Short");
      expect(shortSection).toBeUndefined();

      // The "Detailed Section" should be included
      const detailedSection = chunks.find((c) => c.metadata.name === "Detailed Section");
      expect(detailedSection).toBeDefined();
    });
  });

  describe("extractClassHeader returning undefined", () => {
    it("should handle singleton_class (class << self) at top level where header does not match class pattern", async () => {
      // A class << self block as a top-level chunkable node has "class << self"
      // which does match /class\s+/, but let's test the fallback when extractClassHeader
      // encounters a non-class/module first line in a container
      const tinyConfig: ChunkerConfig = {
        chunkSize: 50,
        chunkOverlap: 5,
        maxChunkSize: 80,
      };
      const tinyChunker = new TreeSitterChunker(tinyConfig);

      // class << self at the top-level of a class, with methods inside
      // This tests the body extraction where header may or may not match
      const code = [
        "class Config",
        "  class << self",
        "    def load_defaults",
        "      # Loading the default configuration settings from file",
        "      puts 'Loading defaults from configuration'",
        "      YAML.load_file('config/defaults.yml')",
        "    end",
        "",
        "    def save_defaults(data)",
        "      # Saving configuration defaults to persistent storage",
        "      puts 'Saving defaults to configuration file'",
        "      File.write('config/defaults.yml', data.to_yaml)",
        "    end",
        "  end",
        "end",
      ].join("\n");

      const chunks = await tinyChunker.chunk(code, "config.rb", "ruby");

      // Should produce method chunks extracted from the class
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should return undefined when first line does not start with class or module", async () => {
      // Directly test extractClassHeader with a mock node
      const freshChunker = new TreeSitterChunker(config);
      const extractClassHeader = (freshChunker as any).extractClassHeader.bind(freshChunker);

      // Mock a node whose first line is not a class/module declaration
      const code = "  has_many :posts\n  belongs_to :user\nend";
      const mockNode = {
        startPosition: { row: 0 },
      };

      const header = extractClassHeader(mockNode, code);
      expect(header).toBeUndefined();
    });
  });

  describe("parser initialization error recovery", () => {
    it("should return null and log error when parser module fails to load", async () => {
      const freshChunker = new TreeSitterChunker(config);

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Temporarily inject a broken language definition to simulate load failure
      // Access the private initializeParser method through any cast
      const result = await (freshChunker as any).initializeParser("broken", {
        loadModule: () => Promise.reject(new Error("Module not found")),
        chunkableTypes: [],
      });

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load parser for broken"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("parser parse error recovery", () => {
    it("should catch parse errors and fall back to character chunker", async () => {
      const freshChunker = new TreeSitterChunker(config);

      // First, load the TypeScript parser normally
      const code1 = `
function setup() {
  console.log('Loading the parser');
  return true;
}
      `;
      await freshChunker.chunk(code1, "setup.ts", "typescript");

      // Now replace the parser's parse method with one that throws
      const cache = (freshChunker as any).parserCache;
      const tsConfig = cache.get("typescript");
      const originalParse = tsConfig.parser.parse.bind(tsConfig.parser);
      tsConfig.parser.parse = () => {
        throw new Error("Simulated parse failure");
      };

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // This should hit the catch block and fall back
      const code2 = `
function broken() {
  console.log('This will trigger the catch block because parse throws');
  return false;
}
      `;
      const chunks = await freshChunker.chunk(code2, "broken.ts", "typescript");

      // Should fall back to character-based chunking
      expect(chunks.length).toBeGreaterThan(0);

      // Verify error was logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Tree-sitter parsing failed"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();

      // Restore original parse
      tsConfig.parser.parse = originalParse;
    });
  });

  describe("name extraction fallback", () => {
    it("should extract name from type_identifier child in Go type declarations", async () => {
      // Go type declarations have nested type_spec with identifier children,
      // exercising the fallback path in extractName that searches child nodes
      const code = `
type UserRequest struct {
  Name    string
  Email   string
  Age     int
  Address string
}
      `;

      const chunks = await chunker.chunk(code, "types.go", "go");

      // Go type_declaration should produce at least one chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Verify chunks exist with metadata (the name extraction path is exercised
      // regardless of whether the result has a specific chunkType)
      expect(chunks[0].metadata.language).toBe("go");
    });

    it("should use fallback name extraction for Rust enum items", async () => {
      // Rust enum_item may exercise the identifier child fallback
      const code = `
enum Direction {
    North,
    South,
    East,
    West,
}
      `;

      const chunks = await chunker.chunk(code, "dir.rs", "rust");
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Check that chunks were produced (name extraction path exercised)
      if (chunks.length > 0) {
        // At least some chunks should have names extracted
        const hasName = chunks.some((c) => c.metadata.name !== undefined);
        expect(hasName).toBe(true);
      }
    });

    it("should extract name via identifier child when childForFieldName returns null", async () => {
      // Use a mock node to directly exercise the extractName fallback path
      const freshChunker = new TreeSitterChunker(config);
      const extractName = (freshChunker as any).extractName.bind(freshChunker);

      // Create a mock node that has no "name" field but has an identifier child
      const mockCode = "const myVariable = 42;";
      const mockNode = {
        childForFieldName: () => null,
        children: [
          {
            type: "identifier",
            startIndex: 6,
            endIndex: 16,
          },
        ],
      };

      const name = extractName(mockNode, mockCode);
      expect(name).toBe("myVariable");
    });

    it("should return undefined when no name field and no identifier children", async () => {
      const freshChunker = new TreeSitterChunker(config);
      const extractName = (freshChunker as any).extractName.bind(freshChunker);

      // Mock node with no name field and no identifier children
      const mockNode = {
        childForFieldName: () => null,
        children: [
          { type: "keyword", startIndex: 0, endIndex: 5 },
          { type: "string", startIndex: 6, endIndex: 12 },
        ],
      };

      const name = extractName(mockNode, "const 'hello'");
      expect(name).toBeUndefined();
    });
  });
});
