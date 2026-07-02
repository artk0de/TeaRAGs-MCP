import { defineFrameworkVocabulary } from "./framework-module.js";

/** Sidekiq / Sidekiq-Pro gem grammar. A `Worker.perform_async(args)` class call
 *  defers to `Worker#perform`; the gem instantiates the worker out of band, so
 *  the static graph never sees the edge. One module file + one FRAMEWORKS line. */
export const SIDEKIQ_VOCABULARY = defineFrameworkVocabulary("sidekiq", {}, undefined, {
  enqueueDispatch: {
    perform_async: "perform",
    perform_in: "perform",
    perform_at: "perform",
    perform_bulk: "perform",
    // `Worker.push_bulk(collection) { |x| [x] }` — Sidekiq batch enqueue class
    // method; the worker is the receiver, so it routes like perform_async
    // (bd tea-rags-mcp-3jf9l; 49 call-sites in bench-mastodon).
    push_bulk: "perform",
  },
});
