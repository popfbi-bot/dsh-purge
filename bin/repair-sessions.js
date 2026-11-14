#!/usr/bin/env node
/**
 * 会话日志体检 / 修复 CLI。
 *
 *   node bin/repair-sessions.js              只体检，列出问题会话
 *   node bin/repair-sessions.js --fix        修复（先备份 .bak-<ts>，校验通过才落盘）
 *   node bin/repair-sessions.js --session <id>   只处理某个会话
 *   node bin/repair-sessions.js --json       机器可读输出
 *
 * 环境：DSH_HOME（缺省按宿主约定推断）、DSH_BASE（缺省指向当前安装的 resources/app）。
 * node 必须带 zstd（v22.15+ / v24+）；没有就报告并退出 3。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listSessionLogs, repairSessionFile, assertZstd } from "../lib/session-repair.js";

function parseArgs(argv) {
  const out = { fix: false, json: false, session: "", all: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fix" || arg === "--apply") out.fix = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--dry-run") out.fix = false;
    else if (arg === "--session") { out.session = argv[++i] || ""; out.all = false; }
    else if (arg.startsWith("--session=")) { out.session = arg.slice(10); out.all = false; }
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "dsh"));
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, ".dsh"));
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "sessions"))) return c; } catch { /* next */ }
  }
  return candidates[0] || "";
}

function resolveValidator() {
  const base = process.env.DSH_BASE || "F:/AI/DSH/DSH NEXT/resources/app";
  const mod = path.join(base, "node_modules", "@deepseek-ai", "dsh-session-format-v3-to-v4", "lib", "index.js");
  if (!fs.existsSync(mod)) return { validator: void 0, reason: `找不到校验器：${mod}` };
  const url = pathToFileURL(mod).href;
  return { resolve: () => import(url).then((m) => m.assertReleasedV4Relationships), reason: mod };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node bin/repair-sessions.js [--fix] [--session <id>] [--json]\n\n` +
    `  --fix            修复并把原文件备份为 <file>.bak-<时间戳>\n` +
    `  --session <id>   只检查/修复指定会话\n` +
    `  --json           输出机器可读 JSON\n\n` +
    `环境变量：DSH_HOME / DSH_BASE`);
  process.exit(0);
}

try {
  assertZstd();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(3);
}

const home = resolveHome();
if (!home || !fs.existsSync(path.join(home, "sessions"))) {
  console.error(`✗ 找不到会话目录：${path.join(home || "<DSH_HOME>", "sessions")}`);
  process.exit(2);
}

const validatorInfo = resolveValidator();
let validator;
if (validatorInfo.resolve) {
  try {
    validator = await validatorInfo.resolve();
  } catch (error) {
    if (!args.json) console.error(`⚠ 校验器加载失败（${error.message}），只做结构重编号不做最终复核`);
  }
}

const logs = listSessionLogs(home).filter((entry) => args.all || entry.sessionId.includes(args.session));
const results = [];
for (const entry of logs) {
  try {
    const result = await repairSessionFile(entry.file, { apply: args.fix, validator });
    results.push({ sessionId: entry.sessionId, ...result });
    if (!args.json) {
      const tag = result.changed ? "✓ 已修复" : result.issues.length > 0 ? "!" : "-";
      const detail = result.issues.length > 0
        ? `${result.issues.length} 处（${result.issues.slice(0, 3).map((i) => `${i.kind}@seq${i.seq}${i.claimed !== void 0 ? ` ${i.claimed}→${i.actual}` : ""}`).join(", ")}${result.issues.length > 3 ? " …" : ""}）`
        : "干净";
      console.log(`${tag} ${entry.sessionId.slice(0, 18)} ${detail}${result.verdict && result.verdict !== "clean" ? ` [${result.verdict}]` : ""}`);
    }
  } catch (error) {
    results.push({ sessionId: entry.sessionId, file: entry.file, ok: false, error: `${error.name}: ${error.message}` });
    if (!args.json) console.log(`✗ ${entry.sessionId.slice(0, 18)} ${error.name}: ${error.message}`);
  }
}

const broken = results.filter((r) => r.issues?.length > 0);
const failed = results.filter((r) => r.ok === false || (r.verdict && r.verdict !== "OK" && r.verdict !== "clean"));

if (args.json) {
  console.log(JSON.stringify({ home, total: results.length, broken: broken.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`\n共 ${results.length} 个会话：问题 ${broken.length}，修复失败 ${failed.length}${args.fix ? "" : "（未加 --fix，仅体检）"}`);
  if (!validator && validatorInfo.reason) console.log(`校验器：${validatorInfo.reason}`);
}

process.exit(failed.length > 0 ? 1 : 0);
