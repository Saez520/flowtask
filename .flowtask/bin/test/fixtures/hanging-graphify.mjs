import fs from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.argv[process.argv.indexOf("--pid-file") + 1];
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  detached: false,
  stdio: "ignore",
});
process.on("SIGTERM", () => {});
fs.writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
