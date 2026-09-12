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

type SignalProcess = (pid: number, signal: 0) => void;

export function pidIsAlive(
  pid: number,
  signalProcess: SignalProcess = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(file: string): ExclusiveOwner {
  const owner = JSON.parse(fs.readFileSync(file, "utf8")) as ExclusiveOwner;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.instanceId) {
    throw new Error("Ownership is present but cannot be verified");
  }
  return owner;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function removeCandidateIfOwned(candidate: string, identity: FileIdentity): boolean {
  try {
    const current = fs.statSync(candidate);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return true;
    fs.rmSync(candidate, { force: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function createOwner(file: string, owner: ExclusiveOwner): number {
  const candidate = `${file}.${process.pid}.${randomUUID()}.candidate`;
  const handle = fs.openSync(candidate, "wx", 0o600);
  const identity = fs.fstatSync(handle);
  try {
    fs.writeFileSync(handle, JSON.stringify(owner));
    fs.fsyncSync(handle);
    // A hard link publishes complete owner metadata without replacing an
    // existing owner and without exposing an empty lock if this process dies.
    fs.linkSync(candidate, file);
  } catch (error) {
    fs.closeSync(handle);
    removeCandidateIfOwned(candidate, identity);
    throw error;
  }
  if (!removeCandidateIfOwned(candidate, identity)) {
    queueMicrotask(() => removeCandidateIfOwned(candidate, identity));
  }
  return handle;
}

/**
 * Claims an ownership file. Stale replacement is serialized by a second,
 * cross-process exclusive file so an observer can never unlink a new owner.
 */
export function acquireExclusiveOwnership(
  file: string,
  owner: ExclusiveOwner,
  isAlive: (pid: number) => boolean = pidIsAlive,
): number {
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
  if (isAlive(observed.pid)) {
    throw new OwnershipBusyError();
  }

  const takeoverFile = `${file}.takeover`;
  const takeoverHandle = acquireExclusiveOwnership(takeoverFile, owner, isAlive);

  try {
    // Revalidate while holding the cross-process takeover gate. Another
    // contender may have replaced the stale owner after our first read.
    const current = readOwner(file);
    if (current.pid !== observed.pid || current.instanceId !== observed.instanceId) {
      throw new OwnershipBusyError();
    }
    if (isAlive(current.pid)) {
      throw new OwnershipBusyError();
    }
    fs.rmSync(file);
    return createOwner(file, owner);
  } finally {
    releaseExclusiveOwnership(takeoverFile, takeoverHandle, owner);
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
