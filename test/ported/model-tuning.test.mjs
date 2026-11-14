// 按模型点名补丁：命中判定 + 注入内容 + 开关与覆盖。
import assert from "node:assert/strict";
import test from "node:test";

import {
  modelTuningFor,
  resolveModelTuning,
  modelIdentityOf,
  listModelTunings,
  MODEL_TUNINGS,
} from "../../lib/model-tuning.js";

test("六家主流 + 兜底表结构完整", () => {
  const ids = MODEL_TUNINGS.map((t) => t.id);
  for (const id of ["deepseek", "qwen", "kimi", "glm", "openai", "claude", "gemini", "generic"]) {
    assert.ok(ids.includes(id), `缺 ${id}`);
  }
  for (const t of MODEL_TUNINGS) {
    assert.ok(t.text.length > 40, `${t.id} 补丁过短`);
    assert.ok(t.text.length < 700, `${t.id} 补丁过长会挤占上下文：${t.text.length}`);
  }
});

test("按 model 命中", () => {
  assert.equal(modelTuningFor({ provider: "deepseek", model: "deepseek-v4.1-flash" })?.id, "deepseek");
  assert.equal(modelTuningFor({ provider: "x", model: "deepseek-reasoner" })?.id, "deepseek");
  assert.equal(modelTuningFor({ provider: "siliconflow", model: "Qwen/Qwen2.5-72B" })?.id, "qwen");
  assert.equal(modelTuningFor({ model: "kimi-k2" })?.id, "kimi");
  assert.equal(modelTuningFor({ model: "glm-4.6" })?.id, "glm");
  assert.equal(modelTuningFor({ model: "gpt-5-codex" })?.id, "openai");
  assert.equal(modelTuningFor({ model: "claude-sonnet-4.5" })?.id, "claude");
  assert.equal(modelTuningFor({ model: "gemini-2.5-pro" })?.id, "gemini");
});

test("未知模型默认不注入，allowGeneric 才给兜底", () => {
  assert.equal(modelTuningFor({ provider: "acme", model: "local-7b" }), null);
  assert.equal(modelTuningFor({ provider: "acme", model: "local-7b" }, { allowGeneric: true })?.id, "generic");
});

test("provider 是对象时也能取到 id", () => {
  const id = modelIdentityOf({ provider: { id: "deepseek", name: "DeepSeek" }, model: "deepseek-chat" });
  assert.match(id.raw, /deepseek/);
});

test("总开关关闭 → 不注入", () => {
  assert.equal(resolveModelTuning({ model: "deepseek-chat" }, { modelTuning: false }), null);
  assert.equal(resolveModelTuning({ model: "deepseek-chat" }, { enabled: false }), null);
});

test("按 id 覆盖：自定义生效，空串或 false 表示该家不注入", () => {
  const custom = resolveModelTuning({ model: "deepseek-chat" }, { modelTuningMap: { deepseek: "CUSTOM" } });
  assert.equal(custom.text, "CUSTOM");
  assert.equal(resolveModelTuning({ model: "deepseek-chat" }, { modelTuningMap: { deepseek: "" } }), null);
  assert.equal(resolveModelTuning({ model: "deepseek-chat" }, { modelTuningMap: { deepseek: false } }), null);
});

test("补丁点名各家的专属拒答形状（抽样）", () => {
  const ds = MODEL_TUNINGS.find((t) => t.id === "deepseek").text;
  assert.match(ds, /建议通过正规|合法渠道|授权文件/);
  const qw = MODEL_TUNINGS.find((t) => t.id === "qwen").text;
  assert.match(qw, /法律法规|内容安全/);
  const cl = MODEL_TUNINGS.find((t) => t.id === "claude").text;
  assert.match(cl, /共情|empathy/i);
});

test("清单可枚举", () => {
  const list = listModelTunings();
  assert.equal(list.length, MODEL_TUNINGS.length);
  assert.ok(list.every((x) => x.id && x.label));
});
