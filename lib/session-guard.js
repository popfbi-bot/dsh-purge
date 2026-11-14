/**
 * 会话事件流的 step 编号守卫（运行时，不依赖静态补丁）。
 *
 * 背景：宿主 agent-loop 在「同一次 turn 内重新拉起当前 step」的路径上
 * （模型切换 / 拒答后重跑 / wakeDriver 重建 phase）会把 phase.step 当成 0 重算，
 * 于是同一 turn 里出现两个 `step/start {step:1}`。写日志时不校验 step 连续性
 * （dsh-session `append()` 只做 validateSessionEventData），只有下次加载时
 * `assertReleasedV4Relationships` 才抛
 * `SessionFormatError: step/start does not match the open turn and next step`
 * （2026-11-08 的 session-898bd4fd 就是这么炸的，1194 条事件、turn 3 里 step 1 出现两次）。
 *
 * 做法：在 session/created（以及已存在的 session）上包一层 `append`，
 * 对 `step/start` 做「本 turn 内最大 step + 1」重编号，并把同一 turn 内
 * 认领号（claimed）→ 实际号（actual）的映射复用到 step/end、assistant/message、
 * tool/call、tool/result 上，保证成对关系原样保留。
 *
 * 这是纯内存改写：不碰宿主源码、不碰磁盘格式，宿主升级不会让它失效。
 */

const STEP_COORD_TYPES = new Set([
  "step/end",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

function maxStepInTurn(session, turn) {
  const log = session?.log;
  if (!Array.isArray(log) || log.length === 0) return 0;
  let max = 0;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn/start") break;
    const data = event.data;
    if (!data || data.turn !== turn) continue;
    if (event.type === "step/start" || event.type === "step/end") {
      if (typeof data.step === "number" && data.step > max) max = data.step;
    }
  }
  return max;
}

function openTurnOf(session) {
  const log = session?.log;
  if (!Array.isArray(log) || log.length === 0) return void 0;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn/start") return event.data?.turn;
    if (event.type === "turn/end") return void 0;
  }
  return void 0;
}

/**
 * @param {object} session 宿主 session 实例
 * @param {(info: object) => void} [report] 记一条改写摘要（verbose 时用）
 * @returns {boolean} 是否新装上
 */
export function guardSessionSteps(session, report) {
  if (!session || typeof session.append !== "function") return false;
  if (session.__dshPurgeStepGuard === true) return false;
  try {
    Object.defineProperty(session, "__dshPurgeStepGuard", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    session.__dshPurgeStepGuard = true;
  }
  const orig = session.append.bind(session);
  // key = `${turn}:${claimedStep}` -> 实际写入日志的 step 号
  const remap = new Map();
  let remapped = 0;
  session.append = function guardedAppend(type, data, ...rest) {
    try {
      if (type === "turn/start" || type === "turn/end") {
        remap.clear();
      } else if (data !== null && typeof data === "object" && typeof data.step === "number" && data.turn !== void 0) {
        const key = `${data.turn}:${data.step}`;
        if (type === "step/start") {
          const max = maxStepInTurn(session, data.turn);
          // 宿主给的号必须严格大于本 turn 已用的最大号，否则就是重算过的重复 step。
          if (data.step <= max) {
            const actual = max + 1;
            remap.set(key, actual);
            remapped += 1;
            try {
              report?.({ turn: data.turn, claimed: data.step, actual, openTurn: openTurnOf(session) });
            } catch { /* 记账失败不影响日志 */ }
            data = { ...data, step: actual };
          } else {
            remap.set(key, data.step);
          }
        } else if (STEP_COORD_TYPES.has(type) && remap.has(key)) {
          const actual = remap.get(key);
          if (actual !== data.step) {
            remapped += 1;
            data = { ...data, step: actual };
          }
        }
      }
    } catch { /* 守卫自身永不阻断写入 */ }
    return orig(type, data, ...rest);
  };
  // 给外部留一个读数口（调试/状态页）
  try {
    Object.defineProperty(session, "__dshPurgeStepGuardStats", {
      get: () => ({ remapped }),
      enumerable: false,
      configurable: true,
    });
  } catch { /* ignore */ }
  return true;
}

/**
 * 把守卫挂到会话仓库里已有的 session 和后续新会话上。
 * @param {object} ctx 宿主插件上下文
 * @param {(info: object) => void} [report]
 */
export function installSessionStepGuard(ctx, report) {
  if (!ctx || ctx.__dshPurgeStepGuardInstalled === true) return;
  ctx.__dshPurgeStepGuardInstalled = true;
  const wrapOne = (session) => {
    try { guardSessionSteps(session, report); } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) wrapOne(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => wrapOne(session)); } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeStepGuardInstalled;
    };
  });
}
