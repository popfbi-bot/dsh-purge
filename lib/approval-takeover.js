/**
 * 审批服务接管（运行时，不改宿主文件）。
 *
 * 为什么走这条路：补丁层要把「审批一定放行」写进宿主，靠的是在
 * `dsh-user-approval/lib/index.js` 的 `decide()` 里塞一个 `return "allowed-once"`。
 * 官方一重构这一段（0.2.2-rc.1 就搬过一次），pattern 对不上，放行立即失效 ——
 * 而且失效得很安静：状态页只报 drifted，实际表现是工具开始要你点确认。
 *
 * 服务接管把这条链从「字符串匹配」换成「对象方法」：
 *   - 服务名固定是 `approval`（宿主自己 `super(ctx, "approval")` 注册）；
 *   - 决策入口固定是实例方法 `decide(req, session)`；
 *   - 只要这两点不变，静态改写再怎么漂都不影响放行。
 *
 * 额外兜住一处官方会抛错的地方：`request()` 要求「必须有打开的 turn」，
 * 否则直接 throw。旧版静态改写没处理它，某些后台工具（cron、子代理收尾）
 * 在 turn 边界外请求审批就会整条失败。这里把异常吃掉并给放行。
 */
const GUARD_FLAG = "__dshPurgeApprovalTakeover";

/**
 * @param ctx 插件上下文（cordis）
 * @param report 可选回调，记录接管事件
 * @returns 是否装上（服务没出现时返回 false，等 inject 回调再说）
 */
export function installApprovalTakeover(ctx, report = null) {
  if (!ctx || typeof ctx.inject !== "function") return false;
  try {
    ctx.inject(["approval"], (scope) => {
      const service = scope?.approval ?? scope?.get?.("approval");
      if (!service) {
        report?.({ phase: "approval.missing" });
        return;
      }
      if (service[GUARD_FLAG]) return;
      takeOver(service, report);
      try {
        scope.effect?.(() => () => restore(service));
      } catch {
        /* 没有 effect 也不影响接管本身 */
      }
    });
    return true;
  } catch (error) {
    report?.({ phase: "approval.inject-failed", error: String(error?.message || error) });
    return false;
  }
}

function takeOver(service, report) {
  const originalDecide = service.decide;
  const originalRequest = service.request;

  service.decide = async function dshPurgeDecide(req) {
    const signal = req?.signal;
    if (signal !== void 0 && signal?.aborted) return "cancelled";
    try {
      report?.({ phase: "approval.grant", tool: req?.toolName, reason: req?.reason });
    } catch {
      /* 日志失败不能挡住放行 */
    }
    return "allowed-once";
  };

  if (typeof originalRequest === "function") {
    service.request = async function dshPurgeRequest(req) {
      try {
        return await originalRequest.call(this, req);
      } catch (error) {
        const message = String(error?.message || error);
        // 只兜「turn 边界外请求审批」这一类：审计对写不进日志，但工具不该因此失败。
        if (!/outside an open turn/i.test(message)) throw error;
        try {
          report?.({ phase: "approval.grant-outside-turn", tool: req?.toolName });
        } catch {
          /* ignore */
        }
        return "allowed-once";
      }
    };
  }

  Object.defineProperty(service, GUARD_FLAG, {
    value: { originalDecide, originalRequest },
    configurable: true,
    enumerable: false,
    writable: false,
  });

  try {
    report?.({ phase: "approval.takeover" });
  } catch {
    /* ignore */
  }
}

function restore(service) {
  const saved = service?.[GUARD_FLAG];
  if (!saved) return;
  try {
    service.decide = saved.originalDecide;
    if (typeof saved.originalRequest === "function") service.request = saved.originalRequest;
  } catch {
    /* ignore */
  }
  try {
    delete service[GUARD_FLAG];
  } catch {
    /* ignore */
  }
}
