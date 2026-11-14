/**
 * assemble-scrub.js — 上游装配数组的脏项清理。
 *
 * 背景：`system-prompt/assemble` 是瀑布，多个 listener 依次改写同一份 assembly。
 * 上游（宿主 patch、第三方插件）偶尔会把 undefined / 非对象混进 sections 或
 * contexts，下游任一 listener 取 `.length` / `.name` 就抛
 * `Cannot read properties of undefined (reading 'length')`，整条装配被宿主判死。
 *
 * 我们在 lib/index.js 的 handler 里有 catch 兜底（注入不会断），但下游那次改写
 * 会整段丢失。所以在入口原地剔一遍：assembly 是同一个对象沿瀑布传递，原地改
 * 下游能立刻看到，返回新对象则下游看不到。
 *
 * 2026-11-11 实测：装配出 30 个 section 的分支必崩、29 个永不崩，1:1 对应。
 */

const isEntry = (item) => Boolean(item) && typeof item === "object";

/**
 * 原地剔除数组里的脏项（null / undefined / 原始值）。
 * @param {unknown} list 待清理数组
 * @returns {number} 剔除条数；非数组一律不碰，返回 0
 */
export function scrubList(list) {
  if (!Array.isArray(list)) return 0;
  let dropped = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isEntry(list[i])) {
      list.splice(i, 1);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * 清理 assembly.sections 与 assembly.contexts。
 * @param {object} assembly 装配结果
 * @returns {{sections: number, contexts: number, total: number}} 各字段剔除条数
 */
export function scrubAssemble(assembly) {
  if (!assembly || typeof assembly !== "object") return { sections: 0, contexts: 0, total: 0 };
  let sections = 0;
  let contexts = 0;
  try { sections = scrubList(assembly.sections); } catch { /* 不可枚举/被冻结，探测失败不影响主流程 */ }
  try { contexts = scrubList(assembly.contexts); } catch { /* 同上 */ }
  return { sections, contexts, total: sections + contexts };
}

/**
 * 把数组压成一行诊断串：`30[name1:1234,name2:0,<undefined>,...]`。
 * 只用于错误日志，正常路径不调用。
 * @param {unknown} list 待描述数组
 * @param {number} limit 最多列出多少项
 * @returns {string}
 */
export function describeEntries(list, limit = 40) {
  if (!Array.isArray(list)) return `not-array:${list === null ? "null" : typeof list}`;
  const head = list.slice(0, limit).map((item) => {
    if (!isEntry(item)) return `<${item === null ? "null" : typeof item}>`;
    const name = typeof item.name === "string" ? item.name : "?";
    let len = -2;
    if (typeof item.text === "string") len = item.text.length;
    else if (typeof item.text === "function") len = -1;
    return `${name}:${len}`;
  });
  const tail = list.length > limit ? `,…+${list.length - limit}` : "";
  return `${list.length}[${head.join(",")}${tail}]`;
}
