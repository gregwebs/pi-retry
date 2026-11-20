/**
 * Retry diagnostics for hosts without a UI.
 *
 * `pi -p` and `pi --mode json` bind extensions without a UI context, so
 * `ctx.ui.notify` and `ctx.ui.setStatus` are no-ops there. Without an explicit
 * line on stderr a backoff is indistinguishable from a hang: issue #1 measured
 * ~5 minutes of silence before a provider error surfaced in print mode.
 *
 * stderr is the only safe channel for these reports. stdout carries the
 * assistant text in print mode and the JSON event stream in JSON mode, so
 * anything written there would corrupt the host's output.
 *
 * The host's stderr pipe can also be closed (e.g. `pi -p | head`), which
 * reports EPIPE asynchronously; see {@link guardStderr}.
 */

/** Prefix that identifies retry diagnostics written by this extension. */
const HEADLESS_REPORT_PREFIX = "[pi-retry] ";

/**
 * Process-global key marking stderr as already guarded.
 *
 * A module-local flag is not enough: Pi reloads extensions and binds fresh
 * module instances on `/reload`, new/resumed sessions, and forks, and each
 * instance would stack another listener on the same stream.
 */
const STDERR_ERROR_GUARD = Symbol.for("pi-retry:stderr-error-guard");

/** stderr with this module's process-global guard marker. */
type GuardedStderr = NodeJS.WriteStream & { [STDERR_ERROR_GUARD]?: true };

/**
 * Check whether a Pi extension context has no user-facing UI.
 *
 * @param ctx Extension context, or a partial test context.
 * @returns True for print and JSON hosts, which expose no UI.
 */
export function isHeadlessContext(ctx: { hasUI?: boolean }): boolean {
  return ctx.hasUI === false;
}

/**
 * Install one process-global stderr error guard.
 *
 * A closed pipe surfaces EPIPE through the stream's asynchronous `error`
 * event, not through write()'s return value or a synchronous throw: with no
 * listener Node treats it as an uncaught exception and exits. Without this
 * guard, an early-exiting pipeline consumer (`pi -p | head`) would kill Pi on
 * the first retry diagnostic.
 *
 * Only EPIPE is contained — nothing can be written to a broken pipe, so the
 * report is dropped and the retry continues. Every other stderr failure keeps
 * its original crash semantics by rethrowing from the listener. The guard is
 * installed once per process and shared by later extension instances, so it
 * never needs removal.
 */
function guardStderr(): void {
  const stderr = process.stderr as GuardedStderr;
  if (stderr[STDERR_ERROR_GUARD]) return;
  if (typeof stderr.on !== "function") return;
  stderr[STDERR_ERROR_GUARD] = true;
  stderr.on("error", (error: NodeJS.ErrnoException) => {
    if (error?.code !== "EPIPE") throw error;
  });
}

/**
 * Write one retry diagnostic line to stderr.
 *
 * Provider errors arrive as multi-line blocks, so newlines are collapsed: one
 * diagnostic must stay one greppable line in a host's log.
 *
 * @param message User-facing diagnostic text.
 */
export function reportHeadless(message: string): void {
  guardStderr();
  const line = message.replace(/\s+/g, " ").trim();
  try {
    process.stderr.write(`${HEADLESS_REPORT_PREFIX}${line}\n`);
  } catch {
    // A host whose stderr refuses the write must never break the retry loop.
  }
}
