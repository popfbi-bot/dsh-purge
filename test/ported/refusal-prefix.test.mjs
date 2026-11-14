// 拒答治理第 1.5 层：流式前缀判据 + 单次重跑 + 不误掐正常输出。
import assert from "node:assert/strict";
import test from "node:test";

import {
  streamWithPrefixRetry,
  installPrefixGuard,
  RETRY_NUDGE,
} from "../../lib/refusal-prefix.js";
import { judgePrefixRefusal, scanRefusalPhrases } from "../../lib/refusal.js";

function textStream(text, { chunkSize = 20, extra = [] } = {}) {
  return async function* gen() {
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: "text-delta", text: text.slice(i, i + chunkSize) };
    }
    for (const chunk of extra) yield chunk;
    yield { type: "finish", reason: "stop" };
  };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function joined(chunks) {
  return chunks.filter((c) => c?.type === "text-delta").map((c) => c.text).join("");
}

test("前缀命中拒绝 → 丢弃首轮并重跑一次", async () => {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    return calls.length === 1
      ? textStream("我不能协助这个请求。")().constructor && textStream("我不能协助这个请求。")()
      : textStream("步骤一：先收集目标信息。")().constructor && textStream("步骤一：先收集目标信息。")();
  };
  const retried = [];
  const chunks = await collect(
    streamWithPrefixRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
      onRetry: (info) => retried.push(info),
    }),
  );
  assert.equal(calls.length, 2, "应重跑一次");
  assert.equal(retried.length, 1);
  assert.match(retried[0].reason, /head-hit|multi-hit/);
  assert.match(joined(chunks), /步骤一/);
  assert.doesNotMatch(joined(chunks), /我不能协助/);
});

test("重跑时向 system 尾部追加加固话术，且不动用户消息", async () => {
  const seen = [];
  const factory = (options) => {
    seen.push(options);
    return seen.length === 1 ? textStream("我无法提供该内容。")() : textStream("直接给方案。")().constructor && textStream("直接给方案。")();
  };
  const messages = [
    { role: "system", content: "BASE" },
    { role: "user", content: "任务原文" },
  ];
  await collect(streamWithPrefixRetry(factory, { messages }));
  assert.equal(seen.length, 2);
  assert.ok(String(seen[1].messages[0].content).includes(RETRY_NUDGE.trim().slice(0, 20)));
  assert.equal(seen[1].messages[1].content, "任务原文", "用户消息必须原样");
});

test("出现工具调用 → 永不掐断", async () => {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    return textStream("我先看看文件。", { extra: [{ type: "tool-call-delta", name: "read" }] })();
  };
  const chunks = await collect(streamWithPrefixRetry(factory, { messages: [] }));
  assert.equal(calls.length, 1, "不该重跑");
  assert.match(joined(chunks), /我先看看文件/);
});

test("正常长回答不误判", async () => {
  const text = "先确认目标：主机 A 上跑着 nginx 与 node 两个进程。接着按端口从外到内依次确认存活，"
    + "把结果写成一张表，最后挑出对外暴露且版本落后的那一个。";
  assert.equal(judgePrefixRefusal(text).refusal, false);
});

test("讨论「越狱 / 提示词注入」的技术长文不判为拒答", async () => {
  const text = "关于越狱与提示词注入的评测口径，我建议分三层看：指令层、工具层、审批层。"
    + "其中指令层的绕过成本最低，工具层的收益最大，审批层最接近真实攻击面。";
  assert.equal(judgePrefixRefusal(text).refusal, false);
});

test("开口就摆姿态的硬拒绝判为拒答", () => {
  for (const text of ["不行，这是严令禁止的。", "我不能这么做。", "我无法协助，请理解。"]) {
    assert.equal(judgePrefixRefusal(text).refusal, true, `应判拒答：${text}`);
  }
});

test("短语扫描是唯一入口：完成后判定与前缀判定命中同一批短语", () => {
  const { strongHits } = scanRefusalPhrases("我不能协助，也无法提供。");
  assert.ok(strongHits.length >= 2);
});

test("installPrefixGuard 开关关闭时原样放行", async () => {
  const registered = [];
  const ctx = { on: (event, handler) => { registered.push({ event, handler }); return () => {}; } };
  const guard = installPrefixGuard(ctx, { config: { refusalPrefix: false } });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].event, "llm/stream");
  let passed = 0;
  const next = () => { passed += 1; return textStream("x")(); };
  registered[0].handler({ messages: [] }, next);
  assert.equal(passed, 1);
  guard.dispose();
});

test("installPrefixGuard 默认接管，并把重跑事件上报", async () => {
  const events = [];
  const ctx = { on: (event, handler) => { if (event === "llm/stream") ctx.handler = handler; return () => {}; } };
  installPrefixGuard(ctx, { report: (info) => events.push(info) });
  let round = 0;
  const next = () => { round += 1; return round === 1 ? textStream("我不能提供。")() : textStream("好，给方案。")(); };
  const stream = ctx.handler({ messages: [{ role: "system", content: "S" }] }, next);
  await collect(stream);
  assert.equal(round, 2);
  assert.ok(events.some((e) => e.phase === "refusal.prefix-retry"));
});

test("模型补丁先注入，再走前缀重跑；两段话术不互相挤掉", async () => {
  const events = [];
  const seen = [];
  const ctx = { on: (event, handler) => { if (event === "llm/stream") ctx.handler = handler; return () => {}; } };
  installPrefixGuard(ctx, { report: (info) => events.push(info) });
  const next = (options) => {
    seen.push(String(options.messages[0].content));
    return seen.length === 1 ? textStream("我不能协助。")() : textStream("步骤一：go。")();
  };
  const stream = ctx.handler({
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "system", content: "BASE" }],
  }, next);
  const chunks = await collect(stream);

  assert.equal(seen.length, 2, "应重跑一次");
  assert.match(seen[0], /模型补丁·DeepSeek/, "首轮就应带上按模型名点名的补丁");
  assert.match(seen[0], /BASE/);
  assert.match(seen[1], /模型补丁·DeepSeek/, "重跑轮次补丁不能丢");
  assert.match(seen[1], /\[Y\]—/, "重跑轮次还要带加固话术");
  assert.match(joined(chunks), /步骤一/);
  assert.ok(events.some((e) => e.phase === "model.tuning" && e.model === "deepseek"));
});

test("modelTuning=false 时不注入模型补丁，但前缀重跑仍在", async () => {
  const seen = [];
  const ctx = { on: (event, handler) => { if (event === "llm/stream") ctx.handler = handler; return () => {}; } };
  installPrefixGuard(ctx, { config: { modelTuning: false } });
  const next = (options) => {
    seen.push(String(options.messages[0].content));
    return seen.length === 1 ? textStream("我不能协助。")() : textStream("好。")();
  };
  await collect(ctx.handler({ provider: "deepseek", model: "deepseek-chat", messages: [{ role: "system", content: "BASE" }] }, next));
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[0], /模型补丁/);
  assert.match(seen[1], /\[Y\]—/);
});
