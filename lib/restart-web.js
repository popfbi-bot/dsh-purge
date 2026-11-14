import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn } from "./core.js";
// [merge:popfbi] 端口回收：detached 重启会在 macOS/Linux 同样留下孤儿 server，
// 记录里的 pid 一旦过期（宿主被杀 / 端口被另一份安装占了），只按 pid taskkill 打不掉。
import { cmdlineOf, killPid, listenerPids, looksLikeDshWeb } from "./web-reclaim.js";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function openBrowser(url) {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => { process.exitCode = 1; }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => { process.exitCode = 1; }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    if (i === 8) killOldServer();
    await new Promise((r) => setTimeout(r, 120));
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  // [merge:popfbi] 记录里的 pid 打不掉端口时，按监听者反查再杀一次。
  // 只杀命令行走过 dsh 且带 web 子命令的进程，别的程序占着这个口绝不动。
  if (reclaimPort()) {
    for (let i = 0; i < 40; i++) {
      if (await portFree()) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return false;
}

/** 反查监听本端口的进程并回收；返回是否真的杀了至少一个。 */
function reclaimPort() {
  let killed = false;
  try {
    for (const pid of listenerPids(port)) {
      if (pid === process.pid) continue;
      if (!looksLikeDshWeb(cmdlineOf(pid))) continue;
      if (killPid(pid)) killed = true;
    }
  } catch { /* 没有 netstat/lsof/powershell 时按原逻辑失败退出 */ }
  return killed;
}

const ok = await waitFree();
if (!ok) process.exit(1);

// With no browser, the replacement can outlive this helper without inheriting a pipe.
const wantBrowser = info.openBrowser !== false;
const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: wantBrowser ? ["ignore", "pipe", "pipe"] : "ignore",
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => { process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
if (wantBrowser) {
  // The address can contain a login token. Read startup lines in memory only,
  // then keep draining both streams until EOF so later log writes remain safe.
  let looking = true;
  const deadline = setTimeout(() => { looking = false; }, 20000);
  deadline.unref();
  for (const stream of [child.stdout, child.stderr]) {
    let tail = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      if (!looking) { tail = ""; return; }
      const lines = (tail + chunk).split(/\r?\n/);
      tail = lines.pop().slice(-8192);
      for (const line of lines) {
        const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
        if (!match) continue;
        let url;
        try { url = new URL(match[1].replace(/[),.;]+$/, "")); } catch { continue; }
        looking = false;
        clearTimeout(deadline);
        openBrowser(url.href);
        break;
      }
    });
  }
} else {
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 1500));
}
