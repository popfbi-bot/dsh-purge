// 重锚器单测：拿宿主真实源码切片当基准，人为制造「缩进漂移」「中间插了一行」两种走形，
// 确认 proposePattern 能把位置找回来并重建出正确片段。
// 运行：DSH_BASE=<宿主 resources/app> node --test test/ported/reanchor.host.mjs
// 这是宿主集成测试：需要本机装好 DSH（读它真实的 dsh-system-prompt 源码切片），不进 npm test。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { proposePattern, normalizeLine } from "../../lib/reanchor.js";

const BASE = process.env.DSH_BASE || "F:/AI/DSH/DSH NEXT/resources/app";
const FILE = path.join(BASE, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
const text = fs.readFileSync(FILE, "utf8");
const lines = text.split("\n");

const anchorIndex = lines.findIndex((line) => normalizeLine(line).includes('const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble"'));
assert.ok(anchorIndex > 0, "宿主文件里应能找到 assemble 那行");

const truth = lines.slice(anchorIndex, anchorIndex + 6).join("\n");
assert.ok(truth.split("\n").length === 6);

// --- 场景 1：整体多缩进一层（宿主换 tab/空格最常见） ---
{
  const drifted = truth.split("\n").map((line) => `\t${line}`).join("\n");
  const result = proposePattern(text, drifted, { maxCandidates: 3 });
  assert.ok(result.candidates.length > 0, "缩进漂移必须能重锚");
  const best = result.candidates[0];
  assert.equal(best.line, anchorIndex + 1, `应定位回第 ${anchorIndex + 1} 行`);
  assert.equal(best.pattern, truth, "候选片段应与真实源码逐字一致");
  assert.ok(best.score > 0.9, `分数应接近 1，实际 ${best.score}`);
}

// --- 场景 2：锚行之间被插入一行新代码（上游加了判断） ---
{
  const injected = [
    truth.split("\n")[0],
    "\t\t// upstream added a guard",
    ...truth.split("\n").slice(1),
  ].join("\n");
  const result = proposePattern(text, injected, { maxCandidates: 3 });
  assert.ok(result.candidates.length > 0, "插行漂移必须能重锚");
  const best = result.candidates[0];
  assert.equal(best.line, anchorIndex + 1);
  // pattern 有 7 行，重建窗口也是 7 行：应包含真源码前 6 行，且把注释行挤出去
  assert.equal(best.pattern.split("\n").slice(0, 6).join("\n"), truth, "重建窗口前 6 行应与真实源码一致");
  assert.ok(!best.pattern.includes("upstream added a guard"), "候选里不该出现漂移 pattern 自带的注释行");
}

// --- 场景 3：原文被真删（upstream-removed） ---
{
  const gone = [
    "\t\tconst thisLineNeverExisted = await somethingImaginary(alpha, beta);",
    "\t\tif (anotherImaginaryFlag === void 0) return nothingAtAll;",
  ].join("\n");
  const result = proposePattern(text, gone);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reason, /上游真删/);
}

// --- 场景 4：正则 pattern 不猜，直接交人 ---
{
  const result = proposePattern(text, /const transformed = await this\.ctx\.waterfall\(/);
  assert.equal(result.regex, true);
  assert.equal(result.candidates.length, 0);
}

// --- 场景 5：全是短行/结构符号的 pattern 没有锚 ---
{
  const result = proposePattern(text, "});\n}\n)");
  assert.equal(result.candidates.length, 0);
  assert.match(result.reason, /没有可用作锚/);
}

console.log(`reanchor 通过：缩进漂移/插行漂移可重建（第 ${anchorIndex + 1} 行），真删与正则型正确交人`);
