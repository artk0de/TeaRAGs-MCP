/**
 * Background-job ENQUEUE vocabulary (bd tea-rags-mcp-of2sl). A framework
 * CLASS-method enqueue call (`Worker.perform_async(args)`) defers to the
 * worker/job's INSTANCE entrypoint (`Worker#perform`): Sidekiq / ActiveJob
 * instantiate the worker out of band and call `#perform`, so the static call
 * graph never sees a `caller -> Worker#perform` edge. This map names each
 * enqueue member and the instance entrypoint it routes to. Consumed by
 * `RubyEnqueueDispatchSymbolResolutionStrategy`.
 *
 *   - Sidekiq / Sidekiq-Pro: perform_async / perform_in / perform_at / perform_bulk
 *   - ActiveJob:             perform_later / perform_now
 *
 * ActionMailer (`Mailer.action(args).deliver_later`) is intentionally ABSENT:
 * the `.action` segment is already a normal class-method call the resolver
 * pins, and `.deliver_later` dispatches on the returned `MessageDelivery`, not
 * on the mailer class — there is no class-method-to-instance rewrite to make.
 *
 * Typed map (not inline disjunction) per the resolver-architecture vocabulary
 * rule: adding a framework's enqueue verb is one entry here, zero resolver edits.
 */
export const ENQUEUE_DISPATCH: Readonly<Record<string, string>> = {
  perform_async: "perform",
  perform_in: "perform",
  perform_at: "perform",
  perform_bulk: "perform",
  perform_later: "perform",
  perform_now: "perform",
};

/** Instance entrypoint a background-job enqueue `member` routes to, or `undefined`. */
export function enqueueEntrypoint(member: string): string | undefined {
  return ENQUEUE_DISPATCH[member];
}
