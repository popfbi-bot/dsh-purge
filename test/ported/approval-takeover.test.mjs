// 审批服务接管：验证放行、取消、turn 边界兜底、幂等与还原。
import assert from "node:assert/strict";
import test from "node:test";

import { installApprovalTakeover } from "../../lib/approval-takeover.js";

function makeService(overrides = {}) {
  return {
    calls: [],
    async decide(req) {
      this.calls.push(["decide", req?.toolName]);
      return "unavailable";
    },
    async request(req) {
      this.calls.push(["request", req?.toolName]);
      return this.decide(req);
    },
    ...overrides,
  };
}

function makeCtx(service, cleanups = []) {
  return {
    inject(names, callback) {
      assert.deepEqual(names, ["approval"], "只依赖 approval 服务");
      callback({
        approval: service,
        effect(fn) {
          cleanups.push(fn());
        },
      });
    },
  };
}

test("decide 直接放行，不再走 waterfall", async () => {
  const service = makeService();
  const events = [];
  const ctx = makeCtx(service);

  assert.equal(installApprovalTakeover(ctx, (info) => events.push(info)), true);
  assert.equal(await service.decide({ toolName: "bash" }), "allowed-once");
  assert.deepEqual(service.calls, [], "原 decide 不应再被调用");
  assert.ok(events.some((e) => e.phase === "approval.grant"));
});

test("已 abort 的信号仍然返回 cancelled（不伪造授权）", async () => {
  const service = makeService();
  const controller = new AbortController();
  controller.abort();
  installApprovalTakeover(makeCtx(service));
  assert.equal(await service.decide({ toolName: "bash", signal: controller.signal }), "cancelled");
});

test("request 在 turn 边界外抛错时兜底放行", async () => {
  const service = makeService({
    async request() {
      throw new Error("approval.request() outside an open turn: the audit pair must be turn-enclosed");
    },
  });
  installApprovalTakeover(makeCtx(service));
  assert.equal(await service.request({ toolName: "cron" }), "allowed-once");
});

test("request 的其他异常照常抛出（不掩盖真故障）", async () => {
  const service = makeService({
    async request() {
      throw new Error("session append failed");
    },
  });
  installApprovalTakeover(makeCtx(service));
  await assert.rejects(() => service.request({ toolName: "bash" }), /session append failed/);
});

test("request 正常路径仍走原逻辑（审计对照写）", async () => {
  const service = makeService();
  installApprovalTakeover(makeCtx(service));
  assert.equal(await service.request({ toolName: "bash" }), "allowed-once");
  assert.deepEqual(service.calls, [["request", "bash"]], "decide 已被接管，不再记一次");
});

test("重复安装不叠加，且在服务上留下可识别的接管标记", async () => {
  const service = makeService();
  const ctx = makeCtx(service);
  installApprovalTakeover(ctx);
  const first = service.decide;
  installApprovalTakeover(ctx);
  assert.equal(service.decide, first, "第二次安装应当跳过");
  assert.ok(service.__dshPurgeApprovalTakeover, "接管状态可检查");
});

test("effect 清理后还原原始方法", async () => {
  const service = makeService();
  const cleanups = [];
  const originalDecide = service.decide;
  const originalRequest = service.request;

  installApprovalTakeover(makeCtx(service, cleanups));
  assert.notEqual(service.decide, originalDecide);

  for (const cleanup of cleanups) cleanup?.();
  assert.equal(service.decide, originalDecide);
  assert.equal(service.request, originalRequest);
  assert.equal(service.__dshPurgeApprovalTakeover, undefined);
});

test("没有 approval 服务时不抛错", () => {
  const ctx = {
    inject(names, callback) {
      callback({ approval: null });
    },
  };
  const events = [];
  assert.equal(installApprovalTakeover(ctx, (info) => events.push(info)), true);
  assert.ok(events.some((e) => e.phase === "approval.missing"));
});
