/**
 * Diagnostics — primitives layer (`core/primitives/`), I/O-free and importable
 * by every core layer: the process-wide debug flag. It is module state, so one
 * specifier must reach one instance — consumers import this barrel, never the
 * file behind it. The flag is set from config by the composition root and,
 * inside worker threads and child processes, from the init payload the parent
 * ships; it never reads the environment itself.
 */

export { isDebug, setDebug } from "./debug-flag.js";
