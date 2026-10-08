import { readFileSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockOwner {
  pid: number;
  host: string;
}

export function lockPath(workflowFile: string): string {
  return workflowFile.replace(/\.json$/, "") + ".lock";
}

export function describeOwner(owner: LockOwner | undefined): string {
  return owner ? `process ${owner.pid} on ${owner.host}` : "another process";
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Reads the lock: undefined when there is none, otherwise its owner (null owner when unreadable). */
async function readLock(path: string): Promise<{ owner: LockOwner | undefined } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { owner: parseOwner(raw) };
}

/** The owner written in a lock file; undefined when unreadable, which counts as held by an unknown owner (it may be mid-write). */
function parseOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid === "number" && typeof value.host === "string") return { pid: value.pid, host: value.host };
  } catch {
    // Unreadable.
  }
  return undefined;
}

function isOurs(owner: LockOwner | undefined): boolean {
  return owner !== undefined && owner.pid === process.pid && owner.host === hostname();
}

/** The owner of a live lock held by a process other than this one, or undefined when free, ours or stale. */
export async function lockedByOther(path: string): Promise<{ owner: LockOwner | undefined } | undefined> {
  const lock = await readLock(path);
  if (!lock) return undefined;
  const { owner } = lock;
  if (isOurs(owner)) return undefined;
  if (owner && owner.host === hostname() && isGone(owner.pid)) return undefined;
  return lock;
}

export async function isLockedByOther(path: string): Promise<boolean> {
  return (await lockedByOther(path)) !== undefined;
}

/** Takes the lock atomically. Returns undefined on success, or the holder when another live process has it. */
export async function acquireLock(path: string): Promise<{ owner: LockOwner | undefined } | undefined> {
  const body = `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, body, { flag: "wx" });
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const other = await lockedByOther(path);
    if (other) return other;
    const current = await readLock(path);
    // Ours (re-entrant) or stale: ours is kept, stale is removed and retried.
    if (isOurs(current?.owner)) return undefined;
    await rm(path, { force: true });
  }
  return { owner: undefined };
}

/**
 * Releases the lock if this process holds it. Synchronous, so a finished pass
 * can drop it in the same tick in which it stops counting as running.
 */
export function releaseLock(path: string): void {
  try {
    if (isOurs(parseOwner(readFileSync(path, "utf8")))) rmSync(path, { force: true });
  } catch {
    // No lock file, or one we can't read: there is nothing of ours to remove.
  }
}
