export async function checkOllamaAvailability(
  embeddingProvider: string,
  baseUrl?: string,
  modelName?: string,
): Promise<void> {
  if (embeddingProvider !== "ollama") return;

  const url = baseUrl || "http://localhost:11434";
  const model = modelName || "jina-embeddings-v2-base-code";
  const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");

  try {
    const response = await fetch(`${url}/api/version`);
    if (!response.ok) {
      throw new Error(`Ollama returned status ${response.status}`);
    }

    const tagsResponse = await fetch(`${url}/api/tags`);
    const { models } = (await tagsResponse.json()) as { models: { name: string }[] };
    const modelExists = models.some((m) => m.name === model || m.name.startsWith(`${model}:`));

    if (!modelExists) {
      let msg = `Error: Model '${model}' not found in Ollama.\n`;
      if (isLocalhost) {
        msg +=
          `Pull it with:\n` +
          `  - Using Podman: podman exec ollama ollama pull ${model}\n` +
          `  - Using Docker: docker exec ollama ollama pull ${model}\n` +
          `  - Or locally: ollama pull ${model}`;
      } else {
        msg += `Please ensure the model is available on your Ollama instance:\n  ollama pull ${model}`;
      }
      throw new Error(msg);
    }
  } catch (error) {
    // Re-throw "model not found" errors as-is
    if (error instanceof Error && error.message.startsWith("Error: Model")) {
      throw error;
    }

    const errorMessage =
      error instanceof Error ? `Error: ${error.message}` : `Error: Ollama is not running at ${url}.\n`;

    let helpText = "";
    if (isLocalhost) {
      helpText =
        `Please start Ollama:\n` +
        `  - Using Podman: podman compose up -d\n` +
        `  - Using Docker: docker compose up -d\n` +
        `  - Or install locally: curl -fsSL https://ollama.ai/install.sh | sh\n` +
        `\nThen pull the embedding model:\n` +
        `  ollama pull jina-embeddings-v2-base-code`;
    } else {
      helpText =
        `Please ensure:\n` +
        `  - Ollama is running at the specified URL\n` +
        `  - The URL is accessible from this machine\n` +
        `  - The embedding model is available (e.g., jina-embeddings-v2-base-code)`;
    }

    throw new Error(`${errorMessage}\n${helpText}`);
  }
}
