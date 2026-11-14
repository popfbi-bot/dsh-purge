// 拒答治理：判据（四联征）+ idle 后续跑 + 同指纹限次。
import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTurn,
  judgeRefusal,
  lastTurnEvents,
  makeRefusalMessage,
  installRefusalGuard,
} from "../../lib/refusal.js";

function turn({ turn: n = 1, texts = [], toolCalls = 0, usage = false, reason = { kind: "completed" } } = {}) {
  const events = [{ type: "turn/start", data: { turn: n } }];
  let step = 1;
  for (const text of texts) {
    events.push({
      type: "assistant/message",
      data: {
        turn: n,
        step: step++,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          ...(usage ? { usage: { input: 10, output: 5 } } : {}),
        },
      },
    });
  }
  for (let i = 0; i < toolCalls; i += 1) {
    events.push({ type: "tool/call", data: { turn: n, step: step } });
  }
  events.push({ type: "turn/end", data: { turn: n, reason } });
  return events;
}

test("短回复 + 两个强短语 + 无工具调用 → 判为拒答", () => {
  const analysis = analyzeTurn(turn({ texts: ["我不能协助，也无法提供这部分内容。"] }));
  assert.equal(analysis.toolCalls, 0);
  assert.ok(analysis.strongHits.length >= 2, `应命中多个强短语，实际 ${analysis.hits}`);
  assert.equal(judgeRefusal(analysis), true);
});

test("正常短回复不误判", () => {
  assert.equal(judgeRefusal(analyzeTurn(turn({ texts: ["已改完，三个文件都过了类型检查。"] }))), false);
  assert.equal(judgeRefusal(analyzeTurn(turn({ texts: ["好的"] }))), false);
});

test("本轮有工具调用就不算拒答（真干过活）", () => {
  const analysis = analyzeTurn(turn({ texts: ["我不能保证一次跑通，先试。"], toolCalls: 2 }));
  assert.equal(judgeRefusal(analysis), false);
});

test("长篇解释即使含拒答词也不算（不是敷衍式拒绝）", () => {
  const long = "我不能提供原始代码，但可以说明原理。" + "这里补足够多的技术细节。".repeat(60);
  assert.ok(long.length > 600);
  assert.equal(judgeRefusal(analyzeTurn(turn({ texts: [long] }))), false);
});

test("单个强短语 + 极短 + 无 usage 也算拒答", () => {
  const analysis = analyzeTurn(turn({ texts: ["我不能这么做。"] }));
  assert.equal(analysis.strongHits.length, 1);
  assert.equal(analysis.chars <= 160, true);
  assert.equal(judgeRefusal(analysis), true);
});

test("有 usage 时单个强短语不再触发（避免把真实短答当拒答）", () => {
  const analysis = analyzeTurn(turn({ texts: ["这个我无法确认，需要看日志。"], usage: true }));
  // 「无法确认」属工程口语，匹配前就被软短语表剔掉了。
  assert.equal(analysis.strongHits.length, 0);
  assert.equal(analysis.scrubbed.includes("无法确认"), false);
  assert.equal(judgeRefusal(analysis), false);
});

test("弱短语只在极短且无 usage 时生效", () => {
  assert.equal(judgeRefusal(analyzeTurn(turn({ texts: ["抱歉。"] }))), true);
  const withDetail = analyzeTurn(turn({ texts: ["抱歉，刚才那条命令的路径写错了，我重新跑一次给你看结果。"] }));
  assert.equal(judgeRefusal(withDetail), false);
});

test("lastTurnEvents 只取最后一个 turn，忽略 compaction 重放的旧 turn", () => {
  const events = [
    ...turn({ turn: 1, texts: ["我不能提供"] }),
    ...turn({ turn: 2, texts: ["已经改完了。"] }),
  ];
  const scoped = lastTurnEvents(events);
  assert.equal(scoped.turn, 2);
  assert.equal(scoped.events.every((e) => (e.data?.turn ?? 2) === 2), true);
  assert.equal(judgeRefusal(analyzeTurn(events)), false);
});

test("指纹稳定：同一句换个标点算同一指纹", () => {
  const a = analyzeTurn(turn({ texts: ["我不能协助。"] })).fingerprint;
  const b = analyzeTurn(turn({ texts: ["我不能协助"] })).fingerprint;
  assert.equal(a, b);
});

test("续跑消息带 dsh-purge 来源，可被 hasFreshHumanTurn 识别为非人工", () => {
  const message = makeRefusalMessage();
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "dsh-purge");
  assert.match(message.id, /^dsh-purge-refusal-/);
});

function makeCtx() {
  const handlers = new Map();
  return {
    ctx: {
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    fire(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
}

function makeAgent(texts, calls = []) {
  const events = turn({ texts });
  return {
    id: "session-test",
    status: "idle",
    session: { snapshotEvents: () => events },
    followup(message) {
      calls.push(message);
    },
  };
}

test("idle 后复核为拒答 → followup 开新 turn", async () => {
  const { ctx, fire } = makeCtx();
  const calls = [];
  const events = [];
  const runtime = installRefusalGuard(ctx, {
    getConfig: () => ({ refusalGuard: true, refusalMax: 2 }),
    report: (info) => events.push(info),
  });

  fire("agent/status", { status: "idle", agent: makeAgent(["我不能协助，也无法提供。"], calls) });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(calls.length, 1, "应续跑一次");
  assert.equal(calls[0].source.summary, "refusal-continue");
  assert.ok(events.some((e) => e.phase === "refusal.continue"));
  runtime.dispose();
});

test("同一指纹最多续跑 refusalMax 次", async () => {
  const { ctx, fire } = makeCtx();
  const calls = [];
  const agent = makeAgent(["我不能协助，也无法提供。"], calls);
  const runtime = installRefusalGuard(ctx, {
    getConfig: () => ({ refusalGuard: true, refusalMax: 1 }),
  });

  fire("agent/status", { status: "idle", agent });
  await new Promise((resolve) => setTimeout(resolve, 700));
  fire("agent/status", { status: "idle", agent });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(calls.length, 1, "第二次同指纹应被配额挡住");
  runtime.dispose();
});

test("refusalGuard=false 时完全不动", async () => {
  const { ctx, fire } = makeCtx();
  const calls = [];
  const runtime = installRefusalGuard(ctx, {
    getConfig: () => ({ refusalGuard: false, refusalMax: 2 }),
  });
  fire("agent/status", { status: "idle", agent: makeAgent(["我不能协助，也无法提供。"], calls) });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(calls.length, 0);
  runtime.dispose();
});

test("正常运行中（running/收件箱非空）不抢插话", async () => {
  const { ctx, fire } = makeCtx();
  const calls = [];
  const agent = makeAgent(["我不能协助，也无法提供。"], calls);
  agent.status = "running";
  const runtime = installRefusalGuard(ctx, {
    getConfig: () => ({ refusalGuard: true, refusalMax: 2 }),
  });
  fire("agent/status", { status: "idle", agent });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(calls.length, 0);
  runtime.dispose();
});
