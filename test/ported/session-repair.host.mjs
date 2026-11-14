// 会话修复器单测：造一份「同 turn 内重复 step」的日志，确认
//   1) 宿主真实校验器会拒（证明注入的病就是那个病）；
//   2) normalizeSteps 能把它修成合法序列；
//   3) repairSessionFile --apply 落盘后校验器通过，且原文件留在 .bak-*。
// 运行：DSH_BASE=<宿主 resources/app> node --test test/ported/session-repair.host.mjs
// 这是宿主集成测试：需要本机装好 DSH（读它真实的会话格式校验器），不进 npm test。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { decodeLogBuffer, splitLogFrames, encodeLogBuffer, normalizeSteps, repairSessionFile } from "../../lib/session-repair.js";

const BASE = process.env.DSH_BASE || "F:/AI/DSH/DSH NEXT/resources/app";
const modPath = path.join(BASE, "node_modules", "@deepseek-ai", "dsh-session-format-v3-to-v4", "lib", "index.js");
const { assertReleasedV4Relationships } = await import(pathToFileURL(modPath).href);

const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

// 一份最小合法 header：字段跟着宿主 0.2.2-rc.1 的 v4 头走，缺字段校验器会先炸在别处。
const header = {
  version: 4,
  id: "session-00000000-0000-4000-8000-000000000001",
  createdAt: "2026-11-08T00:00:00.000Z",
  cwd: "G:\\AI\\DSH\\DSH-WORK",
};

const events = [
  { seq: 0, type: "turn/start", data: { turn: 1 } },
  { seq: 1, type: "step/start", data: { turn: 1, step: 1 } },
  { seq: 2, type: "step/end", data: { turn: 1, step: 1 } },
  // ↓ 宿主把 phase.step 当 0 重算后的重复 step：这一条让加载器抛 SessionFormatError
  { seq: 3, type: "step/start", data: { turn: 1, step: 1 } },
  { seq: 4, type: "step/end", data: { turn: 1, step: 1 } },
  { seq: 5, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
].map((e) => ({ time: Date.now(), ...e }));

function withSeq(list) {
  return list.map((e, i) => ({ ...e, seq: i }));
}

async function writeLog(file, ev) {
  const frames = [{
    raw: Buffer.alloc(0),
    text: "",
    lines: [],
  }];
  // 单帧即可：header 一行 + 事件若干行
  const text = `${JSON.stringify(header)}\n${ev.map((e) => JSON.stringify(e)).join("\n")}\n`;
  frames[0].text = text;
  frames[0].lines = text.split("\n").filter((l) => l.length > 0);
  const buf = zlib.zstdCompressSync(Buffer.from(text, "utf8"), CHECKSUM_OPTIONS);
  fs.writeFileSync(file, buf);
}

function verifyBuffer(buf) {
  const frames = decodeLogBuffer(buf);
  const { header: h, events: ev } = splitLogFrames(frames);
  const known = new Set(ev.map((e) => e.type));
  assertReleasedV4Relationships({ header: h, inheritedEventCount: 0, events: ev }, known);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-session-repair-"));
const file = path.join(dir, "session.v4.jsonl.zstd");

// 1) 病人：校验器必须拒
await writeLog(file, withSeq(events));
assert.throws(
  () => verifyBuffer(fs.readFileSync(file)),
  (error) => {
    assert.match(error.message, /step\/start does not match the open turn and next step/);
    return true;
  },
  "注入的重复 step 必须被宿主校验器拒绝",
);

// 2) normalizeSteps 直接修
{
  const { header: h, events: ev } = splitLogFrames(decodeLogBuffer(fs.readFileSync(file)));
  const issues = normalizeSteps(ev);
  assert.equal(issues.filter((i) => i.kind === "step-renumber").length, 1);
  assert.deepEqual(ev.filter((e) => e.type === "step/start").map((e) => e.data.step), [1, 2]);
  assert.deepEqual(
    ev.filter((e) => e.type === "step/end").map((e) => e.data.step),
    [1, 2],
    "step/end 必须跟着同一映射走",
  );
  const known = new Set(ev.map((e) => e.type));
  assertReleasedV4Relationships({ header: h, inheritedEventCount: 0, events: ev }, known);
}

// 3) repairSessionFile --apply：落盘 + 备份 + 修后可加载
{
  const result = await repairSessionFile(file, { apply: true, validator: assertReleasedV4Relationships });
  assert.equal(result.changed, true, "应当真的改写文件");
  assert.equal(result.verdict, "OK");
  assert.ok(result.backup && fs.existsSync(result.backup), "必须留下 .bak 备份");
  verifyBuffer(fs.readFileSync(file));
  // 备份仍是坏的那份（没有被顺手修掉，回滚有意义）
  assert.throws(() => verifyBuffer(fs.readFileSync(result.backup)));
}

// 4) 幂等：再跑一次什么都不做
{
  const again = await repairSessionFile(file, { apply: true, validator: assertReleasedV4Relationships });
  assert.equal(again.changed, false);
  assert.equal(again.verdict, "OK");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("session-repair 通过：注入 → 拒绝 → 修复 → 校验 OK → 备份可回滚 → 幂等");

// 5) 伪 magic：压缩数据里偶然出现 0x28b52ffd 时不能把帧切断
{
  const frame = (obj) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  const f1 = frame({ type: "turn/start", seq: 1, data: { turn: 1 } });
  const f2 = frame({ type: "turn/end", seq: 2, data: { turn: 1 } });
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  // 帧之间塞一段以 magic 开头、解不出来的垃圾，模拟伪命中
  const junk = Buffer.concat([MAGIC, Buffer.from("0000000000000010", "hex"), Buffer.alloc(64, 7)]);
  const buffer = Buffer.concat([f1, junk, f2]);
  const frames = decodeLogBuffer(buffer);
  assert.equal(frames.length, 2, "伪 magic 不能凭空多出一帧");
  assert.equal(frames[0].text, `${JSON.stringify({ type: "turn/start", seq: 1, data: { turn: 1 } })}\n`);
  assert.ok(frames[1].text.includes("turn/end"));
}
