import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const directory = join(root, ".collector");
const weather = process.argv.includes("--weather");
const suffix = weather ? "weather" : "collector";
const lane = weather ? ["--weather"] : [];
const lockPath = join(directory, weather ? "weather.pid" : "supervisor.pid");
const logPath = join(directory, suffix + ".log");
const jobPath = join(directory, "lab.polytrader." + suffix + ".plist");
const command = process.argv[2];
mkdirSync(directory, { recursive: true, mode: 0o700 });

function runningSupervisor() {
  try {
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    const commandLine = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return commandLine.includes(script + " supervise") && commandLine.endsWith(" --weather") === weather ? pid : null;
  } catch { return null; }
}

async function supervise() {
  if (runningSupervisor() && runningSupervisor() !== process.pid) return;
  try { writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (runningSupervisor()) return;
    unlinkSync(lockPath);
    try { writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (race) { if (race.code === "EEXIST") return; throw race; }
  }

  const awake = weather && process.platform === "darwin"
    ? spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }) : undefined;
  awake?.once("error", error => console.log(JSON.stringify({ event: "sleep_assertion_error", error: error.message })));
  const shutdown = new AbortController();
  let child;
  let deadline;
  const stop = () => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      deadline = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      deadline.unref();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let delay = 1_000;
    while (!shutdown.signal.aborted) {
      const started = Date.now();
      child = spawn(process.execPath, ["--env-file-if-exists=.env.local", weather ? "scripts/weather-collector.ts" : "scripts/collector.ts"], { cwd: root, stdio: "inherit" });
      const code = await new Promise(resolve => {
        child.once("exit", code => resolve(code));
        child.once("error", () => resolve(null));
      });
      clearTimeout(deadline);
      child = undefined;
      if (shutdown.signal.aborted) break;
      if (code === 64 || code === 78) { process.exitCode = code; break; }
      if (Date.now() - started > 60_000) delay = 1_000;
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "process_restart", exitCode: code, delayMs: delay }));
      await sleep(delay, undefined, { signal: shutdown.signal }).catch(() => {});
      delay = Math.min(60_000, delay * 2);
    }
  } finally {
    awake?.kill();
    if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  }
}

if (command === "supervise") {
  await supervise();
} else if (command === "start") {
  const existing = runningSupervisor();
  if (existing) console.log("Collector already running. PID", existing);
  else {
    if (existsSync(logPath) && statSync(logPath).size > 10_000_000) renameSync(logPath, logPath + ".1");
    const log = openSync(logPath, "a", 0o600);
    try {
      const worker = spawn(process.execPath, [script, "supervise", ...lane], { cwd: root, detached: true, stdio: ["ignore", log, log] });
      worker.unref();
    } finally { closeSync(log); }
    let pid = null;
    for (let i = 0; i < 20 && !pid; i++) { await sleep(100); pid = runningSupervisor(); }
    if (!pid) { console.error("Collector did not start. Log:", logPath); process.exitCode = 1; }
    else console.log("Collector started. PID", pid, "Log:", logPath);
  }
} else if (command === "stop") {
  const pid = runningSupervisor();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 60 && runningSupervisor() === pid; i++) await sleep(200);
    if (runningSupervisor() === pid) { console.error("Collector is still stopping."); process.exitCode = 1; }
    else console.log("Collector stopped.");
  } else console.log("Collector is stopped.");
} else if (command === "status") {
  const pid = runningSupervisor();
  console.log(pid ? "Collector running. PID " + pid : "Collector stopped.", "Log:", logPath);
  if (existsSync(logPath)) {
    const logs = readFileSync(logPath, "utf8").trimEnd().split("\n");
    const heartbeat = logs.findLast(line => line.includes('"event":"heartbeat"') || line.includes('"source":"heartbeat"'));
    if (heartbeat) console.log(heartbeat);
  }
} else if (command === "launchd") {
  const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const argv = [process.execPath, script, "supervise", ...lane].map(value => "    <string>" + xml(value) + "</string>").join("\n");
  writeFileSync(jobPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>lab.polytrader.${suffix}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`, { mode: 0o600 });
  console.log("Generated launchd configuration:", jobPath);
} else {
  console.error("Use start, stop, status or launchd.");
  process.exitCode = 64;
}
