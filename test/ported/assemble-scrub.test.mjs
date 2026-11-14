import test from "node:test";
import assert from "node:assert/strict";
import { scrubList, scrubAssemble, describeEntries } from "../../lib/assemble-scrub.js";

const sec = (name, text) => ({ name, text });

test("scrubList 剔掉 null / undefined / 原始值，保留对象", () => {
  const list = [sec("a", "x"), null, sec("b", "y"), undefined, "junk", 42, sec("c", "")];
  const dropped = scrubList(list);
  assert.equal(dropped, 4);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.name), ["a", "b", "c"]);
});

test("scrubList 对干净数组一条不动", () => {
  const list = [sec("a", "x"), sec("b", "y")];
  assert.equal(scrubList(list), 0);
  assert.equal(list.length, 2);
});

test("scrubList 幂等：第二次剔除 0 条", () => {
  const list = [sec("a", "x"), null];
  assert.equal(scrubList(list), 1);
  assert.equal(scrubList(list), 0);
});

test("scrubList 非数组一律不碰并返回 0", () => {
  for (const bad of [null, undefined, "x", 7, {}, new Set()]) {
    assert.equal(scrubList(bad), 0);
  }
});

test("scrubAssemble 同时清 sections 与 contexts 并给出计数", () => {
  const assembly = {
    sections: [sec("s1", "a"), null, sec("s2", "b")],
    contexts: [sec("c1", "x"), undefined],
  };
  const res = scrubAssemble(assembly);
  assert.deepEqual(res, { sections: 1, contexts: 1, total: 2 });
  assert.equal(assembly.sections.length, 2);
  assert.equal(assembly.contexts.length, 1);
});

test("scrubAssemble 原地修改：同一个引用立刻看到结果", () => {
  const assembly = { sections: [null] };
  const same = assembly;
  scrubAssemble(assembly);
  assert.equal(same.sections.length, 0);
});

test("scrubAssemble 对空对象 / null / 非对象返回 0", () => {
  for (const bad of [null, undefined, 0, "x", true]) {
    assert.deepEqual(scrubAssemble(bad), { sections: 0, contexts: 0, total: 0 });
  }
  assert.deepEqual(scrubAssemble({}), { sections: 0, contexts: 0, total: 0 });
});

test("scrubAssemble 干净装配返回 0 且不改长度", () => {
  const assembly = { sections: [sec("a", "1")], contexts: [sec("b", "2")] };
  assert.equal(scrubAssemble(assembly).total, 0);
  assert.equal(assembly.sections.length, 1);
  assert.equal(assembly.contexts.length, 1);
});

test("describeEntries 输出 长度[name:文本长度,...]", () => {
  const out = describeEntries([sec("persona", "abcd"), sec("env", "")]);
  assert.equal(out, "2[persona:4,env:0]");
});

test("describeEntries 标出脏项而不抛", () => {
  const out = describeEntries([null, { name: "x" }, sec("y", "zz")]);
  assert.equal(out, "3[<null>,x:-2,y:2]");
});

test("describeEntries 非数组给出类型而不是崩", () => {
  assert.equal(describeEntries(undefined), "not-array:undefined");
  assert.equal(describeEntries(null), "not-array:null");
  assert.equal(describeEntries("s"), "not-array:string");
});

test("describeEntries 超长数组截断并标注剩余条数", () => {
  const list = Array.from({ length: 5 }, (_, i) => sec(`n${i}`, "x"));
  const out = describeEntries(list, 3);
  assert.equal(out, "5[n0:1,n1:1,n2:1,…+2]");
});

test("describeEntries 把函数型 text 记为 -1（延迟求值段）", () => {
  assert.equal(describeEntries([{ name: "lazy", text: () => "x" }]), "1[lazy:-1]");
});
