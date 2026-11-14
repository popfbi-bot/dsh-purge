/**
 * 会话日志（session.v4.jsonl.zstd）自检与修复。
 *
 * 用途：宿主只有在「加载会话」时才跑 `assertReleasedV4Relationships`，写日志时
 * `append()` 只校验单条事件结构。于是 step 号重算（同 turn 内两个 `step/start {step:1}`）
 * 当时毫无征兆，等下次打开会话才抛
 * `SessionFormatError: step/start does not match the open turn and next step`，
 * 整个会话在界面上直接「加载失败」（2026-11-08 的 898bd4fd 就是这样丢的）。
 *
 * 这里提供离线扫描 + 重编号修复：
 *   - 逐 turn 维护期望 step 序列（1..N），不符的 step/start 及其段内坐标统一重映射；
 *   - 未改动的帧原样复用字节，只重压缩真正变过的帧（保 CRC 帧边界不变）；
 *   - 落盘前用宿主真实的校验器复核，通过才写；先 copy 备份，再原子替换。
 *
 * 依赖 node 的 zstd（v22.15+ / v24 内置）。插件运行时不 import 本模块，
 * 只有 scripts/repair-sessions.mjs 用，避免老 Electron 的 node 没有 zstd。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

const STEP_COORD_TYPES = new Set([
  "step/start",
  "step/end",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

function hasZstd() {
  return typeof zlib.zstdDecompressSync === "function" && typeof zlib.zstdCompress === "function";
}

export function assertZstd() {
  if (!hasZstd()) {
    throw new Error("当前 node 没有 zstd 支持（需要 v22.15+ 或 v24+）；请用 DSH 自带的 node-runtime 运行");
  }
}

/** 把 zstd 帧序列拆成 {raw,text,lines}，保持帧边界。 */
export function decodeLogBuffer(buf) {
  assertZstd();
  const cuts = [];
  let cursor = buf.indexOf(MAGIC, 0);
  while (cursor !== -1) {
    cuts.push(cursor);
    cursor = buf.indexOf(MAGIC, cursor + 4);
  }
  if (cuts.length === 0) throw new Error("会话日志里没有 zstd 帧");
  cuts.push(buf.length);

  const frames = [];
  let i = 0;
  while (i < cuts.length - 1) {
    let accepted = false;
    // 正常情况下第一段就成；只有 magic 落在压缩数据内部（伪命中）时才需要往后并段。
    for (let j = i + 1; j < Math.min(i + 5, cuts.length); j += 1) {
      const start = cuts[i];
      const end = cuts[j];
      if (end <= start) continue;
      let text;
      try {
        text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
      } catch {
        continue;
      }
      if (!isCompleteLogText(text)) continue;
      frames.push({ raw: buf.subarray(start, end), text, lines: linesOf(text) });
      i = j;
      accepted = true;
      break;
    }
    if (!accepted) {
      // 这一段起点是伪 magic：跳过它，从下一个候选起继续。
      i += 1;
    }
  }
  if (frames.length === 0) throw new Error("会话日志里没有可解码的 zstd 帧");
  return frames;
}

/**
 * 一段解码结果是否是「完整的日志片段」。
 *
 * 这条判据比"能解出字节"强得多：伪 magic 把一帧切断时，解出来的文本一定缺尾巴
 * （最后一行不是完整 JSON），据此就能识别并拒绝这一刀。
 */
function isCompleteLogText(text) {
  if (!text.endsWith("\n")) return false;
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k += 1) {
    if (k === lines.length - 1) {
      if (lines[k].length !== 0) return false;
      continue;
    }
    if (lines[k].length === 0) return false;
    try {
      JSON.parse(lines[k]);
    } catch {
      return false;
    }
  }
  return true;
}

function linesOf(text) {
  return text.split("\n").filter((line) => line.length > 0);
}

/** 帧 → header + 事件数组。 */
export function splitLogFrames(frames) {
  const allLines = frames.flatMap((f) => f.lines);
  if (allLines.length === 0) throw new Error("会话日志为空");
  const header = JSON.parse(allLines[0]);
  const events = allLines.slice(1).map((line) => JSON.parse(line));
  return { header, events };
}

/**
 * 找出所有违反「同 turn 内 step 必须严格递增且从 1 开始」的坐标，并就地修复 events。
 * 返回的 issues 只用于报告，修复已经写进 events。
 */
export function normalizeSteps(events) {
  const issues = [];
  let current = null; // { turn, expected, claimed }
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    if (event.type === "turn/start") {
      current = { turn: data.turn, expected: 1, claimed: void 0 };
      continue;
    }
    if (event.type === "turn/end") {
      current = null;
      continue;
    }
    if (!STEP_COORD_TYPES.has(event.type)) continue;
    if (typeof data.step !== "number" || data.turn === void 0) continue;
    if (current === null || current.turn !== data.turn) {
      // compaction/prune 会把历史 tool/result 按原坐标重放进来（turn 1 的结果出现在 turn 24 之后），
      // 这是合法重放，不是坐标错。只有 step/start 落到无 turn 的位置才值得一提，且仅作提示。
      if (event.type === "step/start") {
        issues.push({ kind: "orphan-step", seq: event.seq, turn: data.turn, step: data.step, fatal: false });
      }
      continue;
    }
    if (event.type === "step/start") {
      const expected = current.expected;
      if (data.step !== expected) {
        issues.push({
          kind: "step-renumber",
          seq: event.seq,
          turn: data.turn,
          claimed: data.step,
          actual: expected,
          fatal: true,
        });
        current.claimed = data.step;
        data.step = expected;
      } else {
        current.claimed = data.step;
      }
      current.expected = expected + 1;
      continue;
    }
    // 段内事件（step/end / assistant/message / tool/call / tool/result）跟随本段 step 号
    if (current.claimed !== void 0 && data.step === current.claimed && current.expected - 1 !== data.step) {
      const actual = current.expected - 1;
      if (actual !== data.step) {
        issues.push({ kind: "coord-follow", seq: event.seq, type: event.type, turn: data.turn, from: data.step, to: actual, fatal: true });
        data.step = actual;
      }
    }
  }
  return issues;
}

/** 按原帧边界重组；未变的帧复用原字节。 */
export async function encodeLogBuffer(frames, header, events) {
  assertZstd();
  const out = [];
  let cursor = 0;
  let recompressed = 0;
  for (let f = 0; f < frames.length; f += 1) {
    const frame = frames[f];
    const slice = [];
    for (let j = 0; j < frame.lines.length; j += 1) {
      if (f === 0 && j === 0) {
        slice.push(JSON.stringify(header));
        continue;
      }
      slice.push(JSON.stringify(events[cursor]));
      cursor += 1;
    }
    const text = `${slice.join("\n")}\n`;
    if (text === frame.text) {
      out.push(frame.raw);
      continue;
    }
    recompressed += 1;
    out.push(zlib.zstdCompressSync(Buffer.from(text, "utf8"), CHECKSUM_OPTIONS));
  }
  return { buffer: Buffer.concat(out), recompressed };
}

/**
 * @param {string} file session.v4.jsonl.zstd 绝对路径
 * @param {{ apply?: boolean, validator?: (artifact: object, known: Set<string>) => void }} options
 */
export async function repairSessionFile(file, options = {}) {
  const { apply = false, validator } = options;
  const buf = fs.readFileSync(file);
  const frames = decodeLogBuffer(buf);
  const { header, events } = splitLogFrames(frames);
  const issues = normalizeSteps(events);

  const before = { frames: frames.length, events: events.length, bytes: buf.length };
  const fatal = issues.filter((issue) => issue.fatal !== false);
  if (issues.length === 0) {
    return { file, ok: true, changed: false, issues, before, verdict: "OK" };
  }
  if (fatal.length === 0) {
    // 只有提示级问题（例如 compaction 重放留下的 orphan-step），不改字节。
    return { file, ok: true, changed: false, issues, before, verdict: "OK", note: "only non-fatal notes" };
  }

  if (!apply) {
    return { file, ok: false, changed: false, issues, before, verdict: "needs-repair" };
  }

  const { buffer, recompressed } = await encodeLogBuffer(frames, header, events);
  let verdict = "not-checked";
  if (typeof validator === "function") {
    const text = decodeLogBuffer(buffer).flatMap((f) => f.lines).join("\n");
    const lines = text.split("\n").filter((line) => line.length > 0);
    const ev = lines.slice(1).map((line) => JSON.parse(line));
    const known = new Set(ev.map((e) => e.type));
    try {
      validator({ header: JSON.parse(lines[0]), inheritedEventCount: 0, events: ev }, known);
      verdict = "OK";
    } catch (error) {
      verdict = `${error.name}: ${error.message}`;
    }
  }

  if (!apply || verdict === "not-checked" || verdict !== "OK") {
    return { file, ok: verdict === "OK" || verdict === "not-checked", changed: false, issues, before, after: { bytes: buffer.length, recompressed }, verdict };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.tmp-${stamp}`;
  fs.writeFileSync(tmp, buffer);
  const check = fs.readFileSync(tmp);
  if (check.length !== buffer.length) throw new Error(`临时文件长度不符：${check.length} != ${buffer.length}`);
  fs.copyFileSync(tmp, file);
  fs.unlinkSync(tmp);
  return { file, ok: true, changed: true, issues, before, after: { bytes: buffer.length, recompressed }, verdict, backup };
}

/** 枚举 DSH_HOME 下所有会话日志。 */
export function listSessionLogs(dshHome) {
  const root = path.join(dshHome, "sessions");
  const out = [];
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(wsDir, session.name, "session.v4.jsonl.zstd");
      if (fs.existsSync(file)) out.push({ workspace: ws.name, sessionId: session.name, file });
    }
  }
  return out;
}
