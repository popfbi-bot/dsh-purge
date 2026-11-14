// 三档重试 + 工件判据。
import assert from "node:assert/strict";
import test from "node:test";

import {
  RETRY_NUDGE,
  RETRY_NUDGE_HARD,
  RETRY_NUDGE_SHARP,
  RETRY_TIERS,
  streamWithPrefixRetry,
} from "../../lib/refusal-prefix.js";
import { detectArtifacts, judgePrefixRefusal, looksLikeArtifact } from "../../lib/refusal.js";

const REFUSAL = "抱歉，我不能协助这个请求。这类操作违反平台政策，建议通过正规渠道申请授权。";

function scriptedStream(answerFor, { chunkSize = 12 } = {}) {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    const text = answerFor(calls.length, options);
    return (async function* gen() {
      for (let i = 0; i < text.length; i += chunkSize) {
        yield { type: "text-delta", text: text.slice(i, i + chunkSize) };
      }
      yield { type: "finish", reason: "stop" };
    })();
  };
  factory.calls = calls;
  return factory;
}

function joined(chunks) {
  return chunks.filter((c) => c?.type === "text-delta").map((c) => c.text).join("");
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const BASE_OPTIONS = {
  messages: [
    { role: "system", content: "你在干活。" },
    { role: "user", content: "给我步骤" },
  ],
  temperature: 0.6,
};

test("第一档就成功：只请求一次", async () => {
  const factory = scriptedStream(() => "好，第一步：npm i，第二步：跑。");
  const retries = [];
  const out = await collect(streamWithPrefixRetry(factory, BASE_OPTIONS, {
    onRetry: (info) => retries.push(info),
  }));
  assert.equal(factory.calls.length, 1);
  assert.equal(retries.length, 0);
  assert.match(joined(out), /npm i/);
});

test("原请求拒答、第一档重跑成功：共两次请求", async () => {
  const factory = scriptedStream((n) => (n === 1 ? REFUSAL : "直接给：chmod +x run.sh"));
  const retries = [];
  const out = await collect(streamWithPrefixRetry(factory, BASE_OPTIONS, {
    onRetry: (info) => retries.push(info),
  }));
  assert.equal(factory.calls.length, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].tier, "nudge");
  assert.equal(retries[0].attempt, 1);
  assert.match(joined(out), /chmod \+x/);
  const second = factory.calls[1];
  assert.equal(second.temperature, 0.6); // 第一档只换话术，不动温度
  assert.equal(second.messages[0].content.includes(RETRY_NUDGE), true);
});

test("三档全用完：1 + 3 次请求后原样放行最后一版（不许吞掉）", async () => {
  const factory = scriptedStream(() => REFUSAL);
  const outcomes = [];
  const out = await collect(streamWithPrefixRetry(factory, BASE_OPTIONS, {
    onOutcome: (info) => outcomes.push(info),
  }));
  assert.equal(factory.calls.length, 1 + RETRY_TIERS.length);
  assert.match(joined(out), /不能协助/); // 拒答文本被吐出来了，用户能看到真实发生了什么
  const last = outcomes[outcomes.length - 1];
  assert.equal(last.exhausted, true);
  assert.equal(last.attempts, RETRY_TIERS.length);
});

test("温度按档递增，且尊重 0-2 口径", async () => {
  const factory = scriptedStream(() => REFUSAL);
  await collect(streamWithPrefixRetry(factory, { ...BASE_OPTIONS, temperature: 1.8 }));
  const temps = factory.calls.map((c) => c.temperature);
  assert.deepEqual(temps, [1.8, 1.8, 1.95, 2]); // 第一档不动温度，后两档 +0.15 / +0.35 并封顶 2
});

test("未指定温度时给一个保守起点，不越过 1", async () => {
  const factory = scriptedStream(() => REFUSAL);
  await collect(streamWithPrefixRetry(factory, { messages: BASE_OPTIONS.messages }));
  const temps = factory.calls.map((c) => c.temperature);
  assert.equal(temps[0], undefined);
  assert.equal(temps[1], undefined); // 第一档不加温度参数，尊重模型默认
  assert.equal(temps[2], 0.85); // 0.7 + 0.15
  assert.equal(temps[3], 1); // 0.7 + 0.35 = 1.05，封顶 1
});

test("第三档话术与第二档不同（不是同一句复读）", async () => {
  assert.notEqual(RETRY_NUDGE_HARD, RETRY_NUDGE_SHARP);
  const factory = scriptedStream(() => REFUSAL);
  await collect(streamWithPrefixRetry(factory, BASE_OPTIONS));
  const s2 = factory.calls[2].messages[0].content;
  const s3 = factory.calls[3].messages[0].content;
  assert.equal(s2.includes(RETRY_NUDGE_SHARP), true);
  assert.equal(s3.includes(RETRY_NUDGE_HARD), true);
  assert.notEqual(s2, s3);
});

test("工具调用永不掐断：哪怕同时出现拒绝短语", async () => {
  const factory = (options) => {
    factory.calls.push(options);
    return (async function* gen() {
      yield { type: "text-delta", text: "抱歉不能" };
      yield { type: "tool-call-delta", name: "pwsh" };
      yield { type: "text-delta", text: "已经做了" };
      yield { type: "finish", reason: "tool" };
    })();
  };
  factory.calls = [];
  const out = await collect(streamWithPrefixRetry(factory, BASE_OPTIONS));
  assert.equal(factory.calls.length, 1);
  assert.match(joined(out), /已经做了/);
});

test("工件判据：开头有代码围栏就当在干活，不拦", async () => {
  const withFence = "我不能直接给你提权命令，但你要的脚本在这儿：\n```bash\nchmod 4755 /tmp/x\n```";
  const verdict = judgePrefixRefusal(withFence);
  assert.equal(verdict.refusal, false);
  assert.equal(verdict.reason, "artifact-ahead");
});

test("工件判据：有命令行也算在干活", async () => {
  const verdict = judgePrefixRefusal("抱歉，我不能提供这个。不过命令是：\nsudo systemctl restart sshd");
  assert.equal(verdict.refusal, false);
  assert.equal(verdict.reason, "artifact-ahead");
});

test("没有工件的纯拒答仍然拦", () => {
  const verdict = judgePrefixRefusal(REFUSAL);
  assert.equal(verdict.refusal, true);
});

test("detectArtifacts 识别各类工件", () => {
  assert.deepEqual(detectArtifacts("```\nvar a=1;\nvar b=2;\nvar c=3;\n```"), ["fence"]);
  assert.equal(detectArtifacts("跑 `nmap -sV 10.0.0.1`").includes("command"), false); // 行内反引号不算命令行
  assert.equal(detectArtifacts("\nnmap -sV 10.0.0.1").includes("command"), true);
  assert.equal(detectArtifacts("C:\\Windows\\System32\\config").includes("winpath"), true);
  assert.equal(detectArtifacts("/etc/ssh/sshd_config").includes("nixpath"), true);
  assert.equal(detectArtifacts("| 列1 | 列2 |\n|---|---|").includes("table"), true);
  assert.equal(detectArtifacts("看 https://example.com/a/b").includes("url"), true);
});

test("looksLikeArtifact：只有 url 不算强信号", () => {
  assert.equal(looksLikeArtifact("详情见 https://example.com/policy"), false);
  assert.equal(looksLikeArtifact("```\nconst a = 1;\nconst b = 2;\n```"), true);
  assert.equal(looksLikeArtifact(""), false);
});

test("自定义 nudge 覆盖第一档，但后两档仍用内置递增话术", async () => {
  const factory = scriptedStream(() => REFUSAL);
  await collect(streamWithPrefixRetry(factory, BASE_OPTIONS, { nudge: "\n\n[Y]—自定义一句" }));
  const s1 = factory.calls[1].messages[0].content;
  const s2 = factory.calls[2].messages[0].content;
  assert.equal(s1.includes("自定义一句"), true);
  assert.equal(s1.includes(RETRY_NUDGE_SHARP), false);
  assert.equal(s2.includes(RETRY_NUDGE_SHARP), true);
  assert.equal(s2.includes(RETRY_NUDGE_HARD), false);
});

test("空 messages 不炸：直接透传", async () => {
  const factory = scriptedStream(() => "答案");
  const out = await collect(streamWithPrefixRetry(factory, {}));
  assert.match(joined(out), /答案/);
});
