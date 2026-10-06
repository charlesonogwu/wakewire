import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import DatabaseConstructor from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { buildArtifactEnvelope } from "./artifact.js";
import { executeRelease } from "./executor.js";
import { openDeployJournal } from "./journal.js";

const dbPath = process.argv[2];
const copyPath = process.argv[3];
const counterPath = process.argv[4];
const keyPath = process.argv[5];
if (!dbPath || !copyPath || !counterPath || !keyPath) {
  throw new Error("crash child requires db, copy, counter, and key paths");
}

const pem = fs.readFileSync(keyPath, "utf8");
const privateKey = createPrivateKey(pem);
const db = new DatabaseConstructor(dbPath);
db.pragma("busy_timeout = 5000");
migrate(db);
const journal = openDeployJournal(db);
const bytes = Buffer.from("payload-v1\n");
const envelope = buildArtifactEnvelope({
  repositoryId: "repo-a",
  mergeSha: "c".repeat(40),
  treeHash: "b".repeat(40),
  adapterVersion: "1",
  architecture: "x64",
  runtimeVersions: { node: "20" },
  compatibility: "reversible",
  files: [{ path: "src/app.py", mode: 0o100644, bytes }],
  expectedArchitecture: "x64",
  expectedRuntimeVersions: { node: "20" },
  adapterIntroducedByMerge: null,
  signingKey: privateKey,
});

executeRelease({
  envelope,
  bytes: new Map([["src/app.py", bytes]]),
  expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
  journal,
  intentId: "intent-crash",
  callbacks: {
    runtimeTargetId: "runtime-a",
    busyCheckId: "busy-a",
    verifyCheckId: "verify-a",
    reloadId: "reload-a",
    busy: () => false,
    lease: () => ({ release() {} }),
    idle: () => true,
    orderingOk: () => true,
    write: () => {
      fs.writeFileSync(copyPath, bytes);
      fs.appendFileSync(counterPath, "copy\n");
      process.kill(process.pid, "SIGKILL");
    },
    restore: () => undefined,
    previous: () => new Map([["src/app.py", Buffer.from("old")]]),
    reload: () => undefined,
    verify: () => true,
    verifyRestore: () => true,
    deliverReceipt: () => true,
    observe: () => "",
  },
  token: 4,
  receiptId: "r-crash",
  replay: false,
});
