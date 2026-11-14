// 会话 step 守卫单测：模拟宿主 session.append 的写入路径，校验重复 step 被重编号、
// 且成对事件（step/end / assistant/message / tool/call / tool/result）跟随同一映射。
// 运行：node scripts/dev/session-guard.test.mjs
import assert from "node:assert/strict";
import { guardSessionSteps } from "../../lib/session-guard.js";

function makeSession() {
  const session = {
    log: [],
    append(type, data) {
      this.log.push({ type, seq: this.log.length, data });
      return this.log.at(-1);
    },
    turns: () => {
      const byTurn = new Map();
      for (const e of this.log) {
        if (e.data?.turn === void 0) continue;
        const key = e.data.turn;
        if (!byTurn.has(key)) byTurn.set(key, { steps: [] });
        if (e.type === "step/start") byTurn.get(key).steps.push(e.data.step);
      }
      return byTurn;
    },
  };
  return session;
}

const lines = [];
guardSessionSteps(makeSession(), (info) => lines.push(info));

// --- 场景 1：同一 turn 内 step 号被宿主重算（898bd4fd 的真实形态） ---
{
  const s = makeSession();
  assert.equal(guardSessionSteps(s, (info) => lines.push(info)), true);
  assert.equal(guardSessionSteps(s), false, "重复安装应被幂等拦住");

  s.append("turn/start", { turn: 3 });
  s.append("step/start", { turn: 3, step: 1 });
  s.append("assistant/message", { turn: 3, step: 1, text: "不行" });
  s.append("step/end", { turn: 3, step: 1 });
  // 宿主把 phase.step 当 0 重算 → 又是 step 1
  s.append("step/start", { turn: 3, step: 1 });
  s.append("assistant/message", { turn: 3, step: 1, text: "真回答" });
  s.append("tool/call", { turn: 3, step: 1, toolName: "bash" });
  s.append("tool/result", { turn: 3, step: 1, toolName: "bash" });
  s.append("step/end", { turn: 3, step: 1 });
  s.append("turn/end", { turn: 3, reason: { kind: "completed" } });

  const steps = s.log.filter((e) => e.type === "step/start").map((e) => e.data.step);
  assert.deepEqual(steps, [1, 2], "重复 step 应被改写为 2");

  // 前 3 条是原始 step 1（step/start、assistant/message、step/end），第 4 条起是重算后的那段
  const second = s.log.filter((e) => e.type !== "turn/start" && e.type !== "turn/end").slice(3);
  assert.deepEqual(
    second.map((e) => e.data.step),
    [2, 2, 2, 2, 2],
    "同一 claimed step 的后续事件必须整体跟随到 2",
  );
  assert.deepEqual(
    second.map((e) => e.type),
    ["step/start", "assistant/message", "tool/call", "tool/result", "step/end"],
  );
  assert.equal(s.log.find((e) => e.type === "turn/end").data.turn, 3);
}

// --- 场景 2：正常递增不动 ---
{
  const s = makeSession();
  guardSessionSteps(s);
  s.append("turn/start", { turn: 4 });
  s.append("step/start", { turn: 4, step: 1 });
  s.append("step/end", { turn: 4, step: 1 });
  s.append("step/start", { turn: 4, step: 2 });
  s.append("step/end", { turn: 4, step: 2 });
  assert.deepEqual(
    s.log.filter((e) => e.type === "step/start").map((e) => e.data.step),
    [1, 2],
  );
}

// --- 场景 3：新 turn 重置映射，不会把上一 turn 的改写带过来 ---
{
  const s = makeSession();
  guardSessionSteps(s);
  s.append("turn/start", { turn: 5 });
  s.append("step/start", { turn: 5, step: 1 });
  s.append("step/start", { turn: 5, step: 1 }); // 冲突 → 2
  s.append("turn/end", { turn: 5, reason: { kind: "completed" } });
  s.append("turn/start", { turn: 6 });
  s.append("step/start", { turn: 6, step: 1 }); // 合法，不该被改写
  assert.deepEqual(
    s.log.filter((e) => e.type === "step/start").map((e) => [e.data.turn, e.data.step]),
    [[5, 1], [5, 2], [6, 1]],
  );
}

// --- 场景 4：无 turn 坐标的事件原样透传 ---
{
  const s = makeSession();
  guardSessionSteps(s);
  s.append("system/message", { text: "runtime" });
  s.append("model/changed", { from: "a", to: "b" });
  assert.equal(s.log.length, 2);
  assert.equal(s.log[0].data.step, void 0);
}

// --- 场景 5：守卫自身不因畸形 data 抛错 ---
{
  const s = makeSession();
  guardSessionSteps(s);
  s.append("step/start", void 0);
  s.append("step/start", { turn: 1, step: "x" });
  s.append("step/start", null);
  assert.equal(s.log.length, 3);
}

console.log(`session-guard 通过：改写记录 ${lines.length} 条`);
for (const l of lines) console.log("  ", JSON.stringify(l));
