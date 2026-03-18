/**
 * ONNX embedding provider errors.
 */

import { EmbeddingError } from "../errors.js";

export class OnnxModelLoadError extends EmbeddingError {
  constructor(modelPath: string, cause?: Error) {
    super({
      code: "INFRA_ONNX_MODEL_LOAD_FAILED",
      message: `Failed to load ONNX model from ${modelPath}`,
      hint: "Verify the model path exists and has correct permissions",
      httpStatus: 503,
      cause,
    });
  }
}

export class OnnxInferenceError extends EmbeddingError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INFRA_ONNX_INFERENCE_FAILED",
      message: `ONNX inference failed: ${detail}`,
      hint: "Check input dimensions and model compatibility",
      httpStatus: 500,
      cause,
    });
  }
}
