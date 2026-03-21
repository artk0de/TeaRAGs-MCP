import { afterEach, describe, expect, it } from "vitest";

import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from "../../../../../src/core/adapters/embeddings/ollama/errors.js";

// Re-export for testing — these are module-private, tested indirectly through error hints
// getOllamaCommands is tested via hint content; isLocalUrl via withFallback behavior

describe("getOllamaCommands (platform-aware hints)", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(process, "platform", { value: platform });
  }

  describe("macOS (darwin)", () => {
    it("should use 'open -a Ollama' as start command in single-url hint", () => {
      setPlatform("darwin");
      const error = new OllamaUnavailableError("http://localhost:11434");
      expect(error.hint).toContain("open -a Ollama");
      expect(error.hint).not.toContain("ollama serve");
    });

    it("should use 'open -a Ollama' in withFallback local hint", () => {
      setPlatform("darwin");
      const error = OllamaUnavailableError.withFallback("http://192.168.1.71:11434", "http://localhost:11434");
      expect(error.hint).toContain("open -a Ollama");
    });

    it("should include osascript stop command in withFallback hint", () => {
      setPlatform("darwin");
      const error = OllamaUnavailableError.withFallback("http://localhost:11434", "http://192.168.1.71:11434");
      expect(error.hint).toContain("osascript");
      expect(error.hint).toContain("quit app");
    });
  });

  describe("Linux", () => {
    it("should use 'ollama serve' as start command in single-url hint", () => {
      setPlatform("linux");
      const error = new OllamaUnavailableError("http://localhost:11434");
      expect(error.hint).toContain("ollama serve");
    });

    it("should include 'pkill ollama' stop command in withFallback hint", () => {
      setPlatform("linux");
      const error = OllamaUnavailableError.withFallback("http://localhost:11434", "http://192.168.1.50:11434");
      expect(error.hint).toContain("pkill ollama");
    });
  });

  describe("Windows (win32)", () => {
    it("should use 'ollama serve' as start command in single-url hint", () => {
      setPlatform("win32");
      const error = new OllamaUnavailableError("http://localhost:11434");
      expect(error.hint).toContain("ollama serve");
    });

    it("should include 'taskkill' stop command in withFallback hint", () => {
      setPlatform("win32");
      const error = OllamaUnavailableError.withFallback("http://localhost:11434", "http://10.0.0.5:11434");
      expect(error.hint).toContain("taskkill");
      expect(error.hint).toContain("ollama.exe");
    });
  });
});

describe("isLocalUrl (RFC1918 private ranges)", () => {
  // isLocalUrl is tested indirectly via withFallback hint behavior:
  // local URLs → start hint, remote URLs → connectivity-only hint

  const remotePrimaryUrl = "https://ollama.example.com:11434";
  const remoteFallbackUrl = "https://ollama2.example.com:11434";

  it("should detect localhost as local", () => {
    const error = OllamaUnavailableError.withFallback("http://localhost:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 127.0.0.1 as local", () => {
    const error = OllamaUnavailableError.withFallback("http://127.0.0.1:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 127.x.x.x loopback range as local", () => {
    const error = OllamaUnavailableError.withFallback("http://127.0.0.2:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 192.168.x.x as local", () => {
    const error = OllamaUnavailableError.withFallback(remotePrimaryUrl, "http://192.168.1.71:11434");
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 10.x.x.x as local", () => {
    const error = OllamaUnavailableError.withFallback("http://10.0.0.5:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 172.16.x.x as local", () => {
    const error = OllamaUnavailableError.withFallback("http://172.16.0.1:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should detect 172.31.x.x as local (upper bound)", () => {
    const error = OllamaUnavailableError.withFallback("http://172.31.255.255:11434", remoteFallbackUrl);
    expect(error.hint).toContain("Start Ollama");
  });

  it("should NOT detect 172.32.x.x as local (outside range)", () => {
    const error = OllamaUnavailableError.withFallback("http://172.32.0.1:11434", remoteFallbackUrl);
    expect(error.hint).not.toContain("Start Ollama");
    expect(error.hint).toContain("Check network connectivity");
  });

  it("should NOT detect public IPs as local", () => {
    const error = OllamaUnavailableError.withFallback(remotePrimaryUrl, remoteFallbackUrl);
    expect(error.hint).not.toContain("Start Ollama");
    expect(error.hint).toContain("Check network connectivity");
  });

  it("should detect local in fallback URL (not just primary)", () => {
    const error = OllamaUnavailableError.withFallback(remotePrimaryUrl, "http://192.168.0.1:11434");
    expect(error.hint).toContain("Start Ollama");
  });
});

describe("OllamaUnavailableError", () => {
  it("should include URL in message", () => {
    const error = new OllamaUnavailableError("http://localhost:11434");
    expect(error.message).toContain("http://localhost:11434");
  });

  it("should preserve responseStatus", () => {
    const error = new OllamaUnavailableError("http://localhost:11434", undefined, 429);
    expect(error.responseStatus).toBe(429);
  });

  it("withFallback should include both URLs in message", () => {
    const error = OllamaUnavailableError.withFallback("http://192.168.1.71:11434", "http://localhost:11434");
    expect(error.message).toContain("192.168.1.71:11434");
    expect(error.message).toContain("localhost:11434");
    expect(error.message).toContain("primary");
    expect(error.message).toContain("fallback");
  });

  it("withFallback should include stop hint when local URL detected", () => {
    const error = OllamaUnavailableError.withFallback("http://localhost:11434", "http://192.168.1.71:11434");
    // Should have both start and stop
    expect(error.hint).toContain("Start Ollama");
    expect(error.hint).toMatch(/stop|quit|kill|taskkill/i);
  });

  it("withFallback should NOT include stop hint for remote-only URLs", () => {
    const error = OllamaUnavailableError.withFallback(
      "https://ollama.example.com:11434",
      "https://ollama2.example.com:11434",
    );
    expect(error.hint).not.toMatch(/stop|quit|kill|taskkill/i);
  });
});

describe("OllamaModelMissingError", () => {
  it("should include model name and URL", () => {
    const error = new OllamaModelMissingError("nomic-embed-text", "http://localhost:11434");
    expect(error.message).toContain("nomic-embed-text");
    expect(error.message).toContain("http://localhost:11434");
  });

  it("should suggest ollama pull in hint", () => {
    const error = new OllamaModelMissingError("nomic-embed-text", "http://localhost:11434");
    expect(error.hint).toContain("ollama pull nomic-embed-text");
  });
});
