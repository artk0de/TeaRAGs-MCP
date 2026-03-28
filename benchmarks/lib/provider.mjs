import { config } from "./config.mjs";

export async function createEmbeddingProvider() {
  const provider = process.env.EMBEDDING_PROVIDER || "ollama";

  if (provider === "onnx") {
    const { OnnxEmbeddings } = await import("../../build/core/adapters/embeddings/onnx.js");
    const onnx = new OnnxEmbeddings(config.EMBEDDING_MODEL);
    if ("initialize" in onnx) {
      await onnx.initialize();
    }
    return { provider: onnx, name: "onnx" };
  }

  const { OllamaEmbeddings } = await import("../../build/core/adapters/embeddings/ollama.js");
  const ollama = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSION,
    undefined,
    config.EMBEDDING_BASE_URL,
  );
  return { provider: ollama, name: "ollama" };
}

export async function checkProviderConnectivity() {
  const provider = process.env.EMBEDDING_PROVIDER || "ollama";

  if (provider === "onnx") {
    try {
      await import("../../build/core/adapters/embeddings/onnx.js");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `ONNX not available: ${e.message}` };
    }
  }

  // Ollama
  try {
    const response = await fetch(`${config.EMBEDDING_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, error: `Ollama HTTP ${response.status}` };

    const { models } = await response.json();
    const modelNames = (models || []).map((m) => m.name.replace(/:latest$/, ""));
    const target = config.EMBEDDING_MODEL.replace(/:latest$/, "");
    if (!modelNames.some((n) => n === target || n === config.EMBEDDING_MODEL)) {
      return { ok: false, error: `Model "${config.EMBEDDING_MODEL}" not found` };
    }
    return { ok: true };
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") {
      return { ok: false, error: `Cannot connect to Ollama at ${config.EMBEDDING_BASE_URL}` };
    }
    return { ok: false, error: e.message };
  }
}
