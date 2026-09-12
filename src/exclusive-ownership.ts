import { randomUUID } from "node:crypto";
import fs from "node:fs";

export interface ExclusiveOwner {
  pid: number;
  instanceId: string;
}

export class OwnershipBusyError extends Error {
  constructor(message = "Another process already owns this resource") {
    super(message);
    this.name = "OwnershipBusyError";
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(file: string): ExclusiveOwner {
  const owner = JSON.parse(fs.readFileSync(file, "utf8")) as ExclusiveOwner;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.instanceId) {
    throw new Error("Ownership is present but cannot be verified");
  }
  return owner;
}

function createOwner(file: string, owner: ExclusiveOwner): number {
  const handle = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(owner));
    fs.fsyncSync(handle);
    return handle;
  } catch (error) {
    fs.closeSync(handle);
    fs.rmSync(file, { force: true });
    throw error;
  }
}

/**
 * Claims an ownership file. Stale replacement is serialized by a second,
 * cross-process exclusive file so an observer can never unlink a new owner.
 */
export function acquireExclusiveOwnership(file: string, owner: ExclusiveOwner): number {
  try {
    return createOwner(file, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let observed: ExclusiveOwner;
  try {
    observed = readOwner(file);
  } catch {
    throw new Error("Ownership is present but cannot be verified");
  }
  if (processIsAlive(observed.pid)) {
    throw new OwnershipBusyError();
  }

  const takeoverFile = `${file}.takeover`;
  let takeoverHandle: number;
  try {
    takeoverHandle = fs.openSync(takeoverFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new OwnershipBusyError("Ownership takeover is already in progress");
    }
    throw error;
  }

  try {
    // Revalidate while holding the cross-process takeover gate. Another
    // contender may have replaced the stale owner after our first read.
    const current = readOwner(file);
    if (current.pid !== observed.pid || current.instanceId !== observed.instanceId) {
      throw new OwnershipBusyError();
    }
    if (processIsAlive(current.pid)) {
      throw new OwnershipBusyError();
    }
    fs.rmSync(file);
    return createOwner(file, owner);
  } finally {
    fs.closeSync(takeoverHandle);
    fs.rmSync(takeoverFile, { force: true });
  }
}

export async function withExclusiveFileLock<T>(
  file: string,
  action: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const owner = { pid: process.pid, instanceId: randomUUID() };
  const deadline = Date.now() + timeoutMs;
  let handle: number;
  for (;;) {
    try {
      handle = acquireExclusiveOwnership(file, owner);
      break;
    } catch (error) {
      if (!(error instanceof OwnershipBusyError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    releaseExclusiveOwnership(file, handle, owner);
  }
}

export function releaseExclusiveOwnership(
  file: string,
  handle: number,
  owner: ExclusiveOwner,
): void {
  try {
    const current = readOwner(file);
    if (current.pid === owner.pid && current.instanceId === owner.instanceId) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    // The ownership file was already removed or replaced.
  } finally {
    fs.closeSync(handle);
  }
}
