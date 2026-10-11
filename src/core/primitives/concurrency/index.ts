/**
 * Concurrency primitives — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer. Consumers import this barrel, never a file
 * behind it.
 */

export { Semaphore } from "./semaphore.js";
