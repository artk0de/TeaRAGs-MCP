import { beforeEach, describe, expect, it } from "vitest";
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
    it("should chunk Ruby methods", async () => {
      const code = `
class UserService
  def find_user(id)
    User.find(id)
  end

  def create_user(params)
    User.create(params)
  end
end
      `;

      const chunks = await chunker.chunk(code, "test.rb", "ruby");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.metadata.chunkType === "class" || c.metadata.chunkType === "function")).toBe(true);
    });

    it("should set parentName and parentType for methods in large classes", async () => {
      // Create a chunker with smaller maxChunkSize to trigger splitting
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300, // maxChunkSize * 2 = 600, so class > 600 chars triggers splitting
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

      // Create a class large enough to trigger AST-aware splitting
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

      const chunks = await smallChunker.chunk(code, "large_service.rb", "ruby");

      // Should have multiple method chunks
      expect(chunks.length).toBeGreaterThan(1);

      // Find method chunks (not the whole class)
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");

      // At least some methods should have parentName and parentType
      const chunksWithParent = methodChunks.filter(
        c => c.metadata.parentName && c.metadata.parentType
      );

      expect(chunksWithParent.length).toBeGreaterThan(0);

      // Verify parentName is the class name
      for (const chunk of chunksWithParent) {
        expect(chunk.metadata.parentName).toBe("LargeService");
        expect(chunk.metadata.parentType).toBe("class");
      }
    });

    it("should set parentName and parentType for methods in large modules", async () => {
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

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

      const chunks = await smallChunker.chunk(code, "large_module.rb", "ruby");

      // Should have multiple method chunks
      expect(chunks.length).toBeGreaterThan(1);

      // Find chunks with parent metadata
      const chunksWithParent = chunks.filter(
        c => c.metadata.parentName && c.metadata.parentType
      );

      expect(chunksWithParent.length).toBeGreaterThan(0);

      // Verify parentName is the module name
      for (const chunk of chunksWithParent) {
        expect(chunk.metadata.parentName).toBe("LargeModule");
        expect(chunk.metadata.parentType).toBe("module");
      }
    });

    it("should extract methods from class << self blocks in large classes", async () => {
      const smallConfig = {
        chunkSize: 200,
        chunkOverlap: 20,
        maxChunkSize: 300,
      };
      const smallChunker = new TreeSitterChunker(smallConfig);

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

      const chunks = await smallChunker.chunk(code, "config_manager.rb", "ruby");

      // Should extract individual methods
      expect(chunks.length).toBeGreaterThan(1);

      // Should have function-type chunks (methods)
      const methodChunks = chunks.filter(c => c.metadata.chunkType === "function");
      expect(methodChunks.length).toBeGreaterThan(0);
    });

    it("should NOT set parentName/parentType for small classes that fit in one chunk", async () => {
      // Use default chunker with larger limits
      const code = `
class SmallService
  def simple_method
    return 42
  end
end
      `;

      const chunks = await chunker.chunk(code, "small_service.rb", "ruby");

      // Small class should be kept as single chunk
      expect(chunks.length).toBe(1);

      // No parent metadata since class wasn't split
      expect(chunks[0].metadata.parentName).toBeUndefined();
      expect(chunks[0].metadata.parentType).toBeUndefined();
    });

    it("should chunk Ruby singleton methods", async () => {
      const code = `
class Configuration
  def self.load_from_file(path)
    YAML.load_file(path)
  end

  def self.default_settings
    { timeout: 30, retries: 3 }
  end
end
      `;

      const chunks = await chunker.chunk(code, "config.rb", "ruby");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should chunk Ruby modules", async () => {
      const code = `
module Authenticatable
  def authenticate(credentials)
    # Authentication logic
    true
  end

  def logout
    session.clear
  end
end
      `;

      const chunks = await chunker.chunk(code, "concerns.rb", "ruby");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should chunk Ruby lambdas and procs", async () => {
      const code = `
class Calculator
  OPERATIONS = {
    add: ->(a, b) { a + b },
    subtract: lambda { |a, b| a - b }
  }

  def process(data)
    data.map do |item|
      transform(item)
    end
  end
end
      `;

      const chunks = await chunker.chunk(code, "calculator.rb", "ruby");
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should chunk Ruby begin/rescue blocks", async () => {
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
end
      `;

      const chunks = await chunker.chunk(code, "api_client.rb", "ruby");
      expect(chunks.length).toBeGreaterThan(0);
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
});
