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
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid === "number" && typeof value.host === "string") return { owner: { pid: value.pid, host: value.host } };
  } catch {
    // Treated as held by an unknown owner: it may be mid-write.
  }
  return { owner: undefined };
}

/** The owner of a live lock held by a process other than this one, or undefined when free, ours or stale. */
export async function lockedByOther(path: string): Promise<{ owner: LockOwner | undefined } | undefined> {
  const lock = await readLock(path);
  if (!lock) return undefined;
  const { owner } = lock;
  if (owner && owner.pid === process.pid && owner.host === hostname()) return undefined;
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
    if (current?.owner?.pid === process.pid) return undefined;
    await rm(path, { force: true });
  }
  return { owner: undefined };
}

/** Releases the lock if this process holds it. */
export async function releaseLock(path: string): Promise<void> {
  const lock = await readLock(path).catch(() => undefined);
  if (lock?.owner && lock.owner.pid === process.pid && lock.owner.host === hostname()) await rm(path, { force: true });
}
