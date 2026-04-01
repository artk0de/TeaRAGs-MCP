export interface OllamaModelInfo {
  model: string;
  contextLength: number;
  dimensions: number;
}

/**
 * Parse /api/show response into OllamaModelInfo.
 * Keys in model_info are prefixed with architecture name (e.g., "nomic-bert.context_length").
 * We scan all keys for the first match.
 */
export function parseModelInfo(model: string, modelInfo: Record<string, unknown>): OllamaModelInfo | undefined {
  let contextLength: number | undefined;
  let dimensions: number | undefined;

  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      contextLength = value;
    }
    if (key.endsWith(".embedding_length") && typeof value === "number") {
      dimensions = value;
    }
  }

  if (contextLength === undefined || dimensions === undefined) return undefined;

  return { model, contextLength, dimensions };
}
