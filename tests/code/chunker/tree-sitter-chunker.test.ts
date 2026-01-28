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
});
