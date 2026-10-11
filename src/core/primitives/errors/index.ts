/**
 * Error foundation — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer: the `TeaRagsError` base every typed error
 * extends, the config error family, and `UnknownError`. One class definition
 * reached through one specifier keeps `instanceof TeaRagsError` sound across
 * layers. Consumers import this barrel, never a file behind it.
 */

export {
  ConfigError,
  ConfigNotInitializedError,
  ConfigValueInvalidError,
  ConfigValueMissingError,
  TeaRagsError,
  UnknownError,
} from "./tea-rags-error.js";
export type { ConfigErrorCode } from "./tea-rags-error.js";
