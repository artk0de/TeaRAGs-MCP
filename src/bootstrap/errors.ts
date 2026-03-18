/**
 * Configuration errors — thrown during bootstrap when config values are invalid or missing.
 */

import { TeaRagsError } from "../core/infra/errors.js";

/**
 * Abstract base for all configuration errors.
 * Default httpStatus: 400 (client misconfiguration).
 */
export abstract class ConfigError extends TeaRagsError {}

/**
 * Thrown when a configuration field has an invalid value.
 */
export class ConfigValueInvalidError extends ConfigError {
  constructor(field: string, value: string, expected: string) {
    super({
      code: "CONFIG_VALUE_INVALID",
      message: `Invalid value "${value}" for configuration field "${field}"`,
      hint: `Expected one of: ${expected}`,
      httpStatus: 400,
    });
  }
}

/**
 * Thrown when a required configuration field is not set.
 */
export class ConfigValueMissingError extends ConfigError {
  constructor(field: string, envVar: string) {
    super({
      code: "CONFIG_VALUE_MISSING",
      message: `Required configuration field "${field}" is not set`,
      hint: `Set the ${envVar} environment variable`,
      httpStatus: 400,
    });
  }
}
