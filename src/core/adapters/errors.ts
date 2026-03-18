/**
 * Abstract base for all infrastructure/adapter errors.
 *
 * Covers Qdrant, embeddings, git CLI — anything outside the core domain
 * that can fail due to external service unavailability.
 */

import { TeaRagsError } from "../infra/errors.js";

/**
 * Abstract base class for infrastructure errors (adapters, external services).
 * Default httpStatus: 503 (Service Unavailable).
 */
export abstract class InfraError extends TeaRagsError {}
