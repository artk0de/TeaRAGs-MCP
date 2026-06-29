import { defineFrameworkVocabulary } from "./framework-module.js";

/** Sidekiq / Sidekiq-Pro gem grammar. A `Worker.perform_async(args)` class call
 *  defers to `Worker#perform`; the gem instantiates the worker out of band, so
 *  the static graph never sees the edge. One module file + one FRAMEWORKS line. */
export const SIDEKIQ_VOCABULARY = defineFrameworkVocabulary("sidekiq", {}, undefined, {
  enqueueDispatch: { perform_async: "perform", perform_in: "perform", perform_at: "perform", perform_bulk: "perform" },
});
