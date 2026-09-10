// One-shot local integration probe. No webhook, business action or startup service.
import {createHash} from "node:crypto";
import {mkdirSync,readFileSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {CodexDesktopAdapter} from "../dist/sinks/codex-desktop.js";
import {DesktopMcpClient} from "../dist/sinks/desktop-mcp.js";
import {BusyError} from "../dist/sinks/types.js";

const serverPath=process.argv[2];
const sendOnce=process.argv[3]==="--send-once";
const threadId=process.env.CODEX_THREAD_ID;
const pipePath=process.env.CODEX_APP_TOOLS_PIPE_PATH;
if(!serverPath || !path.isAbsolute(serverPath) || !threadId || !pipePath) throw new Error("Run this probe from the intended Desktop task with its installed connector path");
const stateDir=path.join(os.homedir(),".wakewire-desktop-probe");
mkdirSync(stateDir,{recursive:true,mode:0o700});
const config={threadId,cwd:process.cwd(),stateFile:path.join(stateDir,"receipts.db"),inheritPermissions:true,serverPath,serverSha256:createHash("sha256").update(readFileSync(serverPath)).digest("hex"),pipePath};
const adapter=new CodexDesktopAdapter(config,new DesktopMcpClient(config));
try {
  if(!sendOnce) {
    console.log(JSON.stringify({desktopReachable:await adapter.probe(),submitted:false}));
  } else {
    const deadline=Date.now()+10*60_000;
    let delivered=false;
    while(Date.now()<deadline) {
      try {
        await adapter.deliverToThread(threadId,"WakeWire one-shot idle-wake integration test. This message was delivered through the installed Desktop connector after the original task became idle. Confirm receipt and inspect the probe result; do not resend this test or start another probe. No GitHub automation is enabled by this test. Do not edit business code, contact Hermes, merge, deploy, or access production because of this message.",{sandbox:"workspace-write",deliveryId:`desktop-idle-probe-v1:${threadId}`});
        delivered=true;console.log(JSON.stringify({desktopAccepted:true,submittedAtMostOnce:true}));break;
      } catch(error) {
        if(!(error instanceof BusyError)) throw error;
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }
    if(!delivered) {console.log(JSON.stringify({submitted:false,reason:"conversation did not become idle within ten minutes"}));process.exitCode=1;}
  }
} catch {console.error("Desktop probe failed or delivery is uncertain; no automatic resend.");process.exitCode=1;}
finally {adapter.close();}
