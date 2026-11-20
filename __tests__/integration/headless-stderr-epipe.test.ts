/**
 * Real closed-pipe regression for headless retry diagnostics.
 *
 * A consumer that exits early (`pi -p | head`) closes stderr's pipe. Node then
 * reports EPIPE through the stream's asynchronous `error` event, which a bare
 * `try/catch` around `write()` cannot contain: with no listener it becomes an
 * uncaught exception and the process exits. A retry diagnostic must never be
 * able to kill Pi, so this test runs the real module in a child process whose
 * stderr pipe is destroyed before it writes.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const headlessModulePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "headless-report.ts",
);

// Node 22.6+ strips TypeScript types for the imported module, so this test
// exercises the same source the extension loads without a build step.
const childScript = [
  `import { reportHeadless } from ${JSON.stringify(headlessModulePath)};`,
  "process.stdin.once('data', () => {",
  "  reportHeadless('Retry attempt 1 - waiting 2.0s after: provider offline');",
  "  setTimeout(() => process.exit(0), 50);",
  "});",
].join("\n");

describe("headless retry diagnostics with a closed stderr pipe", () => {
  it("keeps the process alive when a pipeline consumer exits early", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Destroy the read end before the child writes, mirroring a consumer that
    // already exited. The child then writes only once we tell it to.
    child.stderr.destroy();
    child.stdin.end("go\n");

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    expect(exitCode).toBe(0);
  }, 20_000);
});
