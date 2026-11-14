/**
 * 补丁重锚（re-anchor）：上游把代码块挪了位置/改了缩进/多插了一行，
 * 原来那串整段 pattern 就一条都不中（状态显示 drifted）。以前只能人工比对。
 *
 * 这里做三件事：
 *   1. 把失败的 pattern 拆成「锚行」（有辨识度、非纯结构符号的行）；
 *   2. 在目标文件里用「空白归一 + 去缩进」的模糊匹配定位锚行；
 *   3. 以命中行起点、按文件真实缩进与行数重建一段候选 pattern，打分给出置信度。
 *
 * 只负责提候选，不自动改 lib/core.js —— 重锚是语义判断，最后一步必须人看。
 */

/** 归一化一行：折叠空白、去掉行尾逗号差异，用于模糊比对。 */
export function normalizeLine(line) {
  return String(line)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*,\s*$/, ",")
    .trim();
}

const STRUCTURAL_ONLY = /^[)\]}]+[;,)]*$|^[({[]$/;

/** 一行是否够格当锚：长度够、不是纯括号、不是注释、不是 import。 */
function isAnchorLine(line) {
  const raw = String(line).trim();
  if (raw.length < 16) return false;
  if (raw.startsWith("//") || raw.startsWith("/*") || raw.startsWith("*")) return false;
  if (STRUCTURAL_ONLY.test(raw)) return false;
  return true;
}

/** 把 pattern（字符串或 RegExp）拆成行数组。 */
export function patternLines(pattern) {
  if (pattern instanceof RegExp) {
    // 正则型 pattern 没法按行重锚，交给人；只回传 source 方便比对。
    return { lines: [pattern.source], regex: true };
  }
  return { lines: String(pattern).split("\n"), regex: false };
}

/**
 * @param {string} fileText 目标文件全文
 * @param {string|RegExp} pattern 失败的 pattern
 * @param {{ maxCandidates?: number }} [options]
 */
export function proposePattern(fileText, pattern, options = {}) {
  const maxCandidates = options.maxCandidates ?? 3;
  const fileLines = String(fileText).split("\n");
  const fileNorm = fileLines.map(normalizeLine);
  const { lines, regex } = patternLines(pattern);
  if (regex) {
    return { regex: true, anchors: [], candidates: [], reason: "regex pattern：需人工重写" };
  }
  const anchors = lines
    .map((line, index) => ({ line, index, norm: normalizeLine(line) }))
    .filter((entry) => isAnchorLine(entry.line));
  if (anchors.length === 0) {
    return { regex: false, anchors: [], candidates: [], reason: "pattern 里没有可用作锚的行（全是短行或结构符号）" };
  }
  // 逐锚在文件里找位置（相同归一化文本）
  const hits = [];
  for (const anchor of anchors) {
    const positions = [];
    for (let i = 0; i < fileNorm.length; i += 1) {
      if (fileNorm[i] === anchor.norm) positions.push(i);
      else if (anchor.norm.length >= 32 && fileNorm[i].includes(anchor.norm)) positions.push(i);
    }
    hits.push({ anchor, positions });
  }
  const found = hits.filter((hit) => hit.positions.length > 0);
  if (found.length === 0) {
    return {
      regex: false,
      anchors: anchors.map((a) => a.line.trim()),
      candidates: [],
      reason: "所有锚行都找不到：上游真删了这段代码（upstream-removed）",
    };
  }
  // 以命中数最多的锚为基准，向上回退到该锚在 pattern 里的行偏移，重建等长片段
  const best = found.reduce((a, b) => (b.positions.length < a.positions.length ? b : a));
  const baseAnchorIndexInPattern = best.anchor.index;
  const candidates = [];
  for (const pos of best.positions.slice(0, maxCandidates)) {
    const start = pos - baseAnchorIndexInPattern;
    if (start < 0 || start + lines.length > fileLines.length) continue;
    const slice = fileLines.slice(start, start + lines.length);
    const rebuilt = slice.join("\n");
    // 打分：与原 pattern 逐行归一化相同比例
    let same = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (normalizeLine(lines[i]) === normalizeLine(slice[i])) same += 1;
    }
    const ratio = same / lines.length;
    const anchorCoverage = found.length / anchors.length;
    candidates.push({
      line: start + 1,
      pattern: rebuilt,
      score: Number((ratio * 0.7 + anchorCoverage * 0.3).toFixed(3)),
      exactLines: same,
      totalLines: lines.length,
      occurrencesOfAnchor: best.positions.length,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return {
    regex: false,
    anchors: anchors.map((a) => a.line.trim()),
    anchorCoverage: Number((found.length / anchors.length).toFixed(2)),
    candidates,
    reason: candidates.length > 0 ? "" : "锚行命中位置太靠文件头尾，无法重建等长片段",
  };
}

/**
 * 批量：给一组 drifted 补丁提候选。
 * @param {(id: number) => string} readTargetFile 由调用方提供「补丁 → 目标文件全文」
 */
export function proposeForPatches(patches, readTargetFile, options = {}) {
  const out = [];
  for (const patch of patches) {
    const fileText = readTargetFile(patch);
    if (typeof fileText !== "string") {
      out.push({ id: patch.id, name: patch.name, skipped: true, reason: "目标文件不存在" });
      continue;
    }
    const reps = Array.isArray(patch.replacements)
      ? patch.replacements
      : (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
    const proposals = [];
    for (const rep of reps) {
      const result = proposePattern(fileText, rep.pattern, options);
      if (result.candidates.length > 0) {
        proposals.push({ from: String(rep.pattern).slice(0, 120), ...result });
      }
    }
    out.push({
      id: patch.id,
      name: patch.name,
      skipped: false,
      proposalCount: proposals.length,
      proposals: proposals.slice(0, options.maxProposalsPerPatch ?? 2),
    });
  }
  return out;
}
