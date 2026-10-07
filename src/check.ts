import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tail } from "./text.ts";
import type { CheckResult } from "./types.ts";

const OUTPUT_TAIL = 12_000;
// Own process group, so cancelling kills the shell and everything it started.
const GROUP = process.platform !== "win32";

/**
 * Runs a step's check command in its directory. Resolves with ok=false for a
 * failing command or a missing directory; rejects only when `signal` aborts.
 */
export function runCheck(command: string, cwd: string, signal?: AbortSignal): Promise<CheckResult> {
  if (!existsSync(cwd)) {
    return Promise.resolve({ ok: false, output: `The check directory does not exist: ${cwd}` });
  }
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let output = "";
    const child = spawn(command, { cwd, shell: true, detached: GROUP, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (GROUP && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill();
      } catch {
        // Already gone.
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString(), OUTPUT_TAIL);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      signal?.removeEventListener("abort", kill);
      resolve({ ok: false, output: `Could not run the check: ${error.message}` });
    });
    child.on("close", (code, killedBy) => {
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) return reject(signal.reason);
      const status = code === 0 ? "" : `\n(exit ${code ?? killedBy})`;
      resolve({ ok: code === 0, output: `$ ${command}\n${output.trimEnd()}${status}` });
    });
  });
}
