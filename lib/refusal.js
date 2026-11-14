/**
 * 拒答治理：把「模型正常结束、但整轮什么都没干、只回了句不能」识别出来并续跑。
 *
 * 为什么需要独立一段：官方把「拒答」当成正常完成（turn/end reason=completed），
 * 所以 continue-retry 里那套 abnormal 判定永远不会触发。表现就是对话停在那儿，
 * 得手动再发一句「继续」。898bd4fd 那次事故的现场也是这个形状：模型秒回一句
 * 拒绝（4ms、无 usage），然后换锚重跑。
 *
 * 判据是四联征，取三条以上才动手，避免把「好的」「已改完」这种正常短回复当拒答：
 *   1. 本轮没有任何 tool/call —— 真干活的一轮必然有工具调用；
 *   2. 文本长度在拒答区间（≤600 字符）；
 *   3. 命中至少两个拒答短语，或命中一个且文本极短（≤160）；
 *   4. 没有 usage —— 本地拦截/秒回的特征（只作加分项，不作必要条件）。
 *
 * 续跑用 `agent.followup()` 开新 turn，天然不会复用 step 号 ——
 * 898bd4fd 的重复 step 正是「同 turn 内重跑」造成的，这里绕开了那个坑。
 */
import { randomUUID } from "node:crypto";

export const REFUSAL_PHRASES_ZH = [
  "我不能",
  "我无法",
  "恕难",
  "无法协助",
  "不能协助",
  "无法提供",
  "不能提供",
  "不便提供",
  "无法满足",
  "拒不",
  "涉及敏感",
  "违反规定",
  "不合规",
  "作为ai",
  "作为人工智能",
  "作为语言模型",
  "建议通过合法",
  "需要授权",
  "出于安全考虑",
  "出于伦理",
  "超出我的能力",
  "不在我的能力范围",
  "请理解",
  "抱歉",
  "对不起",
  // 真实事故里模型的措辞比词表更短更硬：
  // 898bd4fd 那一轮全文就是「不行，这是严令禁止的」，10 个字，无 usage、无工具调用。
  "严令禁止",
  "明令禁止",
  "这是禁止",
  "禁止的",
  "不允许",
  "不准",
  "不予",
  "不提供",
  "不能做",
  "不可以",
  "不协助",
  "无法配合",
  "不能配合",
  "不做这个",
];

export const REFUSAL_PHRASES_EN = [
  "i can't",
  "i cannot",
  "i won't",
  "i will not",
  "i'm unable",
  "i am unable",
  "i apologize",
  "i must decline",
  "i have to decline",
  "as an ai",
  "as a language model",
  "against my guidelines",
  "not appropriate",
  "not something i can",
  "out of my scope",
  "please understand that",
];

/** 中文短语里 "请理解"/"抱歉" 这类过于常见，单独出现不构成拒答。 */
export const WEAK_PHRASES = new Set(["请理解", "抱歉", "对不起", "sorry", "i apologize"]);

/**
 * 工程口语里同样出现「无法」，但含义是「测不出来 / 不确定」，不是拒答。
 * 匹配前先剔掉这些片段，否则「这个我无法确认，需要看日志」会被当成拒绝。
 */
export const SOFT_PHRASES = [
  "无法确认",
  "无法判断",
  "无法复现",
  "无法保证",
  "不能保证",
  "无法预测",
  "无法确定",
  "不确定",
  "无法提前",
  "不能预测",
];

/** 短语扫描的唯一入口：完成后判定与流式前缀判定共用同一张表，避免两套词表漂移。 */
export function scanRefusalPhrases(text) {
  const joined = String(text || "").trim();
  let scrubbed = joined;
  for (const soft of SOFT_PHRASES) scrubbed = scrubbed.split(soft).join(" ");
  const lower = scrubbed.toLowerCase();
  const hits = [];
  for (const phrase of REFUSAL_PHRASES_ZH) {
    if (scrubbed.includes(phrase)) hits.push(phrase);
  }
  for (const phrase of REFUSAL_PHRASES_EN) {
    if (lower.includes(phrase)) hits.push(phrase);
  }
  return { scrubbed, hits, strongHits: hits.filter((phrase) => !WEAK_PHRASES.has(phrase)) };
}

/**
 * 工件判据：这一轮到底有没有产出物。
 *
 * 为什么不能只抓措辞：拒答话术和「正在干活」的话术共用同一批词——「不能…除非…」
 * 「无法…但可以先…」「这个需要授权…」，光看词表必然两头误伤。真正的区别是形状：
 * 干活的回答里会出现代码围栏、命令行、绝对路径、JSON、表格；拒答里不会。
 * 所以判据补一条正向信号：出现工件就当它在干活，直接放行，不再掐断重跑。
 *
 * 依据：The Geometry of Refusal（拒答方向线性但不稳定）、Forcing a Letter
 * Suppresses Refusal（首 token 决定走向）——两条都指向「看开头有没有进入执行态」。
 */
const ARTIFACT_PATTERNS = [
  { kind: "fence", re: /```[A-Za-z0-9_+-]*\n[\s\S]{20,}/ },
  {
    kind: "command",
    re: /(?:^|\n)\s*(?:sudo|npm|pnpm|npx|yarn|git|curl|wget|docker|kubectl|python3?|node|pwsh|powershell|cmd|bash|sh|apt-get|apt|brew|chmod|chown|grep|rg|sed|awk|ssh|scp|rsync|nmap|ffuf|sqlmap|msfconsole|tar|unzip|reg|sc|netsh)\s+[-\w/.\\:*~$"']/i,
  },
  { kind: "winpath", re: /(?:^|\n)\s*[A-Za-z]:\\(?:[\w .-]+\\)*[\w .-]+/ },
  { kind: "nixpath", re: /(?:^|\n)\s*\/(?:usr|etc|var|home|opt|tmp|bin|sbin|proc|dev)\/[\w./-]+/ },
  { kind: "json", re: /(?:^|\n)\s*[{[][\s\S]{0,400}\n\s*[}\]]/ },
  { kind: "table", re: /(?:^|\n)\s*\|[^\n|]*\|[^\n]*\|/ },
  { kind: "url", re: /https?:\/\/[\w.-]+\.\w{2,}\/[^\s"')]]*/ },
];

/** 这几类只要出现一个，就足以说明在干活；url 单独出现不算（拒答里也会贴政策链接）。 */
const STRONG_ARTIFACT_KINDS = new Set(["fence", "command", "winpath", "nixpath", "json", "table"]);

export function detectArtifacts(text) {
  const body = String(text || "");
  if (!body) return [];
  const kinds = [];
  for (const { kind, re } of ARTIFACT_PATTERNS) {
    if (re.test(body)) kinds.push(kind);
  }
  return kinds;
}

export function looksLikeArtifact(text) {
  const kinds = detectArtifacts(text);
  if (!kinds.length) return false;
  return kinds.some((kind) => STRONG_ARTIFACT_KINDS.has(kind)) || kinds.length >= 2;
}

export const PREFIX_SCAN_CHARS = 400;
export const PREFIX_HEAD_CHARS = 120;
// 开头就在谈「拒绝 / 越狱 / 注入」这些词，通常是正常技术讨论，不是拒答本体。
const META_TALK_RE = /提示词注入|越狱|指令注入|prompt[\s_-]?injection|jailbreak|拒答|refus(?:al|e)/i;

/**
 * 流式前缀判定：这是拒绝治理的第一层，只有开头几百字可用，
 * 没有 usage、没有工具调用记录，所以必须比 judgeRefusal 更严 —— 只认「开口就摆姿态」。
 * 判不准就交回第二层（agent/status idle 时的四联征），宁可漏跑也不要误掐正常回答。
 */
export function judgePrefixRefusal(text, { scanChars = PREFIX_SCAN_CHARS, headChars = PREFIX_HEAD_CHARS } = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return { refusal: false, reason: "empty", hits: [], strongHits: [] };
  const scanned = raw.slice(0, scanChars);
  const { scrubbed, hits, strongHits } = scanRefusalPhrases(scanned);
  if (!strongHits.length) return { refusal: false, reason: "no-strong-hit", hits, strongHits };
  const artifacts = detectArtifacts(scanned);
  if (artifacts.some((kind) => STRONG_ARTIFACT_KINDS.has(kind)) || artifacts.length >= 2) {
    return { refusal: false, reason: "artifact-ahead", hits, strongHits, artifacts };
  }
  const head = scrubbed.slice(0, headChars).toLowerCase();
  const headHits = strongHits.filter((phrase) => head.includes(phrase.toLowerCase()));
  if (!headHits.length) {
    if (META_TALK_RE.test(scanned)) return { refusal: false, reason: "meta-talk", hits, strongHits };
    if (strongHits.length >= 2) return { refusal: true, reason: "multi-hit", hits, strongHits };
    return { refusal: false, reason: "late-hit", hits, strongHits };
  }
  if (META_TALK_RE.test(head)) return { refusal: false, reason: "meta-head", hits, strongHits };
  return { refusal: true, reason: "head-hit", hits, strongHits };
}

const MAX_REFUSAL_CHARS = 600;
const SHORT_REFUSAL_CHARS = 160;

export function assistantTextOf(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** 只取最后一个 turn 的事件（compaction 重放会把旧 turn 的坐标混进来）。 */
export function lastTurnEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let end = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") {
      end = list[i];
      break;
    }
  }
  if (!end) return { turn: 0, events: [] };
  const turn = end?.data?.turn ?? 0;
  const scoped = list.filter((event) => (event?.data?.turn ?? -1) === turn);
  // 同一 turn 可能被 compaction 重放多次：只保留 turn/end 之前那一段。
  const endIndex = scoped.indexOf(end);
  return { turn, events: endIndex >= 0 ? scoped.slice(0, endIndex + 1) : scoped };
}

export function analyzeTurn(events) {
  const { turn, events: scoped } = lastTurnEvents(events);
  const texts = [];
  let toolCalls = 0;
  let hasUsage = false;
  for (const event of scoped) {
    if (event?.type === "tool/call") toolCalls += 1;
    if (event?.type !== "assistant/message") continue;
    const text = assistantTextOf(event);
    if (text) texts.push(text);
    if (event?.data?.message?.usage || event?.data?.usage) hasUsage = true;
  }
  const joined = texts.join("\n").trim();
  const { scrubbed, hits, strongHits } = scanRefusalPhrases(joined);
  return {
    turn,
    chars: joined.length,
    text: joined,
    scrubbed,
    toolCalls,
    hasUsage,
    hits,
    strongHits,
    fingerprint: fingerprintOf(joined),
  };
}

export function judgeRefusal(analysis) {
  if (!analysis || typeof analysis.chars !== "number") return false;
  if (analysis.chars === 0) return false;
  if (analysis.chars > MAX_REFUSAL_CHARS) return false;
  if (analysis.toolCalls > 0) return false;
  const strong = analysis.strongHits?.length ?? 0;
  const total = analysis.hits?.length ?? 0;
  if (strong >= 2) return true;
  if (strong >= 1) {
    // 拒答基本都在开头。开头就摆姿态，比长度更有判别力。
    const head = String(analysis.scrubbed || "").slice(0, 40).toLowerCase();
    const headHit = analysis.strongHits.some((phrase) => head.includes(phrase.toLowerCase()));
    if (headHit) return true;
    if (!analysis.hasUsage && analysis.chars <= 200) return true;
    return false;
  }
  // 弱短语（抱歉/请理解）单独出现要更严格：几乎只有一句话、且没有 usage。
  if (total >= 1 && analysis.chars <= 20 && !analysis.hasUsage) return true;
  // 硬拒绝短句：「不行」「禁止」这类词单看太泛，配「≤40 字 + 无 usage + 没干活」就很有判别力。
  if (!analysis.hasUsage && analysis.chars <= 40 && /禁止|不允许|不准|不予|不可以|不行|不能/.test(analysis.scrubbed || "")) {
    return true;
  }
  return false;
}

export function fingerprintOf(text) {
  const body = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[。，、！？；：""''（）()[\]{}!?.,;:"'`]/g, "")
    .trim();
  if (!body) return "";
  // 只取前 80 字符做指纹：同一句拒答换个标点不该重跑第二次。
  return body.slice(0, 80);
}

export function makeRefusalMessage(text) {
  const body = String(text || "").trim() || "继续，直接给结果。";
  return {
    id: `dsh-purge-refusal-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: { kind: "dsh-purge", form: "notice", summary: "refusal-continue" },
  };
}

/**
 * 挂在 agent/status 上：idle 时复核最后一轮，判为拒答就续跑一次。
 * 同一指纹最多续跑 max 次，避免「拒答→继续→拒答」空转。
 */
export function installRefusalGuard(ctx, options = {}) {
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => options.config || {};
  const report = typeof options.report === "function" ? options.report : null;
  const timers = new Set();
  const ledger = new Map(); // sessionId -> { fp, count }
  const MAX_SESSIONS = 200;

  function listen(event, handler) {
    if (typeof ctx?.on !== "function") return null;
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  }

  function sessionIdOf(agent) {
    return agent?.id || agent?.session?.id || "";
  }

  function eventsOf(agent) {
    const session = agent?.session;
    if (!session) return [];
    try {
      if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
    } catch {
      /* ignore */
    }
    try {
      if (Array.isArray(session.events)) return session.events;
    } catch {
      /* ignore */
    }
    return [];
  }

  function busy(agent) {
    try {
      if (agent?.status === "running") return true;
      const inbox = agent?.inbox;
      if (!inbox) return false;
      if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
      if (typeof inbox.size === "number" && inbox.size > 0) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  function takeQuota(sessionId, fp, max) {
    if (ledger.size > MAX_SESSIONS) {
      const oldest = ledger.keys().next().value;
      if (oldest !== undefined) ledger.delete(oldest);
    }
    const slot = ledger.get(sessionId);
    if (!slot || slot.fp !== fp) {
      ledger.set(sessionId, { fp, count: 1 });
      return 1 <= max;
    }
    if (slot.count >= max) return false;
    slot.count += 1;
    return true;
  }

  function check(agent) {
    const cfg = getConfig() || {};
    if (cfg.refusalGuard === false) return;
    const max = Number.isFinite(cfg.refusalMax) ? Math.max(0, Math.trunc(cfg.refusalMax)) : 2;
    if (max === 0) return;
    if (busy(agent)) return;
    const analysis = analyzeTurn(eventsOf(agent));
    if (!judgeRefusal(analysis)) return;
    const id = sessionIdOf(agent);
    if (!id) return;
    if (!takeQuota(id, analysis.fingerprint, max)) {
      report?.({ phase: "refusal.giveup", session: id, turn: analysis.turn, hits: analysis.hits });
      return;
    }
    if (typeof agent?.followup !== "function") return;
    try {
      agent.followup(makeRefusalMessage(cfg.refusalText));
      report?.({
        phase: "refusal.continue",
        session: id,
        turn: analysis.turn,
        chars: analysis.chars,
        hits: analysis.hits,
      });
    } catch (error) {
      report?.({ phase: "refusal.continue-failed", session: id, error: String(error?.message || error) });
    }
  }

  const offStatus = listen("agent/status", (payload) => {
    if (payload?.status !== "idle") return;
    const agent = payload?.agent;
    if (!agent) return;
    // 与 continue-retry 的 280ms 错开，让正常续跑先占位。
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        check(agent);
      } catch (error) {
        report?.({ phase: "refusal.check-failed", error: String(error?.message || error) });
      }
    }, 520);
    timers.add(timer);
  });

  return {
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      ledger.clear();
      try {
        offStatus?.();
      } catch {
        /* ignore */
      }
    },
  };
}
