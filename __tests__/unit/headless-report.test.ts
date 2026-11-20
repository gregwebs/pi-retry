/**
 * Unit tests for headless (print / JSON mode) retry diagnostics.
 *
 * Print and JSON hosts bind extensions without a UI context, so retry
 * notifications and the footer countdown are invisible there. Issue #1
 * reported five minutes of silence for that reason: a retry stall in `pi -p`
 * was indistinguishable from a hang.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHeadlessContext, reportHeadless } from '../../src/headless-report.js';
import { formatWaitNotice, summarizeError } from '../../src/retry-logic.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Count the stderr error listeners this module owns.
 *
 * Pi reloads extensions and binds fresh module instances, so the guard must be
 * process-global; a module-local flag would stack one listener per instance.
 */
function stderrErrorListeners(): number {
  return process.stderr.listenerCount('error');
}

describe('isHeadlessContext', () => {
  it('is true when Pi reports no UI (print and JSON modes)', () => {
    expect(isHeadlessContext({ hasUI: false })).toBe(true);
  });

  it('is false when Pi reports a UI (TUI and RPC modes)', () => {
    expect(isHeadlessContext({ hasUI: true })).toBe(false);
  });

  it('is false for partial test contexts that omit hasUI', () => {
    expect(isHeadlessContext({})).toBe(false);
  });
});

describe('reportHeadless', () => {
  it('writes one prefixed line to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reportHeadless('Retry attempt 1 - waiting 2.0s');

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('[pi-retry] Retry attempt 1 - waiting 2.0s\n');
  });

  it('collapses a multi-line diagnostic into one log line', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reportHeadless('Retry failed at the cap\nbecause of: provider message');

    expect(write.mock.calls[0]?.[0]).toBe('[pi-retry] Retry failed at the cap because of: provider message\n');
  });

  it('does not propagate a synchronous write failure', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EBADF');
    });

    expect(() => reportHeadless('anything')).not.toThrow();
  });

  it('contains a broken-pipe stderr error', () => {
    reportHeadless('Retry attempt 1');

    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
  });

  it('leaves every other stderr error fatal', () => {
    reportHeadless('Retry attempt 1');

    const failure = Object.assign(new Error('write EBADF'), { code: 'EBADF' });
    expect(() => process.stderr.emit('error', failure)).toThrow(failure);
  });

  it('installs one guard even when extensions are reloaded', async () => {
    reportHeadless('warm up the guard');
    const withGuard = stderrErrorListeners();

    // A reload creates a fresh module instance; its guard must reuse the
    // process-global marker instead of stacking another listener.
    vi.resetModules();
    const reloaded = await import('../../src/headless-report.js');
    reloaded.reportHeadless('Retry attempt 1');
    reportHeadless('Retry attempt 2');

    expect(stderrErrorListeners()).toBe(withGuard);
  });
});

describe('summarizeError', () => {
  it('collapses a multi-line provider message into one line', () => {
    const message = 'Antigravity API error\nThis model is unavailable right now.\nNext: switch models.';
    expect(summarizeError(message)).toBe('Antigravity API error This model is unavailable right now. Next: switch models.');
  });

  it('truncates long messages with an ellipsis', () => {
    const summary = summarizeError('x'.repeat(500));

    expect(summary.length).toBe(160);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('returns an empty string when there is no error message', () => {
    expect(summarizeError(undefined)).toBe('');
    expect(summarizeError('   ')).toBe('');
  });
});

describe('formatWaitNotice', () => {
  it('names the attempt, the wait, and a single-line reason', () => {
    expect(formatWaitNotice('Retry attempt 2', 8000, 'fetch failed\nretrying')).toBe(
      'Retry attempt 2 - waiting 8.0s after: fetch failed retrying',
    );
  });

  it('omits the reason when the error message is empty', () => {
    expect(formatWaitNotice('Retry attempt 1', 2000)).toBe('Retry attempt 1 - waiting 2.0s');
  });

  it('names no wait when the delay is zero', () => {
    expect(formatWaitNotice('Retry attempt 1', 0, 'fetch failed')).toBe('Retry attempt 1 after: fetch failed');
  });
});
