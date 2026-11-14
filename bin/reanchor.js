#!/usr/bin/env node
/**
 * 漂移补丁重锚助手。
 *
 *   node bin/reanchor.js                列出 drifted 补丁的重锚候选
 *   node bin/reanchor.js --id 40        只看某条（含已 applied 的，用来验证方法是否靠谱）
 *   node bin/reanchor.js --json         机器可读
 *   node bin/reanchor.js --limit 3      每条补丁最多给几个候选
 *
 * 环境：DSH_BASE（缺省 F:/AI/DSH/DSH NEXT/resources/app）、DSH_HOME。
 * 只提候选、不改 lib/core.js：重锚是语义判断，落地前必须人看。
 */
import fs from "node:fs";
import path from "node:path";
import * as core from "../lib/core.js";
import { proposePattern } from "../lib/reanchor.js";

function parseArgs(argv) {
  const out = { id: 0, json: false, limit: 3, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--id") out.id = Number(argv[++i] || 0);
    else if (arg.startsWith("--id=")) out.id = Number(arg.slice(5) || 0);
    else if (arg === "--limit") out.limit = Number(argv[++i] || 3);
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node bin/reanchor.js [--id <补丁号>] [--limit N] [--json] [--force]\n\n` +
    `  --id      只处理指定补丁（默认只处理 drifted 的）\n` +
    `  --force   即使补丁不是 drifted 也试跑（验证重锚方法本身）\n` +
    `  --limit   每条补丁最多输出几个候选片段\n\n` +
    `环境变量：DSH_BASE / DSH_HOME`);
  process.exit(0);
}

const aiBase = process.env.DSH_BASE
  ? path.join(process.env.DSH_BASE, "node_modules", "@deepseek-ai")
  : path.join("F:/AI/DSH/DSH NEXT/resources/app", "node_modules", "@deepseek-ai");
const state = await core.gatherState();
const targets = core.targetFiles(aiBase);

function fileTextFor(patch) {
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  for (const key of keys) {
    const value = targets[key];
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const fp of list) {
      try {
        if (fs.existsSync(fp)) return { text: fs.readFileSync(fp, "utf8"), file: fp };
      } catch { /* next */ }
    }
  }
  return { text: void 0, file: "" };
}

const all = core.ALL_PATCHES || [];
const picked = all.filter((patch) => {
  if (args.id) return patch.id === args.id;
  const status = state.patch_status[patch.id];
  return status === "drifted" || (args.force && status !== "applied");
});

if (picked.length === 0) {
  const drifted = Object.entries(state.patch_status).filter(([, s]) => s === "drifted").map(([id]) => id);
  console.log(drifted.length === 0
    ? "没有 drifted 补丁（85 条全部 applied/na/skipped）。想看方法是否靠谱用 --id <补丁号> --force。"
    : `drifted 补丁：${drifted.join(", ")}`);
  process.exit(0);
}

const report = [];
for (const patch of picked) {
  const { text, file } = fileTextFor(patch);
  const status = state.patch_status[patch.id];
  if (typeof text !== "string") {
    report.push({ id: patch.id, name: patch.name, status, skipped: true, reason: "目标文件不存在" });
    continue;
  }
  const reps = Array.isArray(patch.replacements)
    ? patch.replacements
    : (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
  const proposals = [];
  for (const rep of reps) {
    const result = proposePattern(text, rep.pattern, { maxCandidates: args.limit });
    if (result.candidates.length > 0) {
      proposals.push({
        sourcePatternHead: String(rep.pattern).slice(0, 100),
        reason: result.reason,
        anchorCoverage: result.anchorCoverage,
        candidates: result.candidates,
      });
    }
  }
  report.push({
    id: patch.id,
    name: patch.name,
    status,
    file,
    replacementCount: reps.length,
    proposalCount: proposals.length,
    proposals: proposals.slice(0, 2),
  });
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const entry of report) {
    console.log(`\n#${entry.id} ${entry.name}  [${entry.status}]`);
    if (entry.skipped) { console.log(`  ⚠ ${entry.reason}`); continue; }
    console.log(`  文件：${entry.file}`);
    if (entry.proposalCount === 0) {
      console.log(`  ✗ 无候选：上游已改写到无法按行重锚，需要人工重写 pattern`);
      continue;
    }
    for (const proposal of entry.proposals) {
      console.log(`  锚覆盖率 ${proposal.anchorCoverage}  候选 ${proposal.candidates.length} 个`);
      for (const candidate of proposal.candidates) {
        console.log(`    · 行 ${candidate.line}  分数 ${candidate.score}  (${candidate.exactLines}/${candidate.totalLines} 行一致)`);
        const preview = candidate.pattern.split("\n").slice(0, 3).map((l) => `+ ${l}`).join("\n");
        console.log(preview.split("\n").map((l) => `      ${l}`).join("\n"));
      }
    }
  }
  console.log(`\n共 ${report.length} 条补丁，${report.filter((r) => r.proposalCount > 0).length} 条有可用候选。`);
}
