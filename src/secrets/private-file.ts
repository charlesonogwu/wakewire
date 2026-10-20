import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Restrict a file to the current user: an owner-only ACL on Windows, 0600 elsewhere. */
export function restrictToOwner(file: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const domain = process.env.USERDOMAIN;
  const user = os.userInfo().username;
  const principal = domain ? `${domain}\\${user}` : user;
  // Drop inherited entries and grant only the current user. icacls is part of Windows.
  execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${principal}:F`], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/**
 * Atomically write a private file. The temporary file is restricted BEFORE the
 * secret content is written, so the content is never readable by other users.
 */
export function writePrivateFile(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, "", { mode: 0o600, flag: "wx" });
    restrictToOwner(temp);
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
