import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DirectorySync = (path: string) => Promise<void>;
/** Node does not expose a portable Windows directory-fsync primitive. File
 * fsync/exclusive locks remain enabled there; do not claim power-loss recovery.
 */
export const syncDirectory: DirectorySync = async (path) => {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export async function createCandidateDirectory(
  root: string,
  key: string,
  sync: DirectorySync = syncDirectory,
) {
  // Operator must provision the root and its durable ancestor entries. Never
  // recursively create ancestors whose directory entries we cannot account for.
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    resolve(await realpath(root)) !== resolve(root) ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Error("state-root-not-private");
  const directory = join(root, key);
  await mkdir(directory, { mode: 0o700 });
  const lock = await open(join(directory, "lock"), "wx", 0o600);
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
  } finally {
    await lock.close();
  }
  await sync(directory);
  await sync(root);
  return directory;
}
