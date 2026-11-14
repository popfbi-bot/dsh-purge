# 合并分支：把自有分支 1.3.2 的独有能力并入社区版

> 基线：`kingcharleslzy-ai/dsh-purge` **1.7.14** @ `fe7d3c3`
> 来源：`popfbi-bot/dsh-purge` **1.3.2** @ `a604f59`
> 分支：`merge/popfbi-unique`（本地，未推送）
> 合并方向：**R1′ —— 社区版做底座，自有分支做增量**（理由见 `dsh-purge-吸收开发文档-20261114.md` 第 2.4 节）

---

## 一、合并结果一句话

社区版原有 88 条补丁、116 个 `lib` 模块、108 个测试文件不动，**新增 14 个模块（2,400 行）+ 2 个 CLI 入口 + 1 条补丁 + 9 个测试文件**；改动集中在 10 个既有文件的接线处（`index.js` 净增 119 行），没有触碰任何补丁的锚点文本。

---

## 二、移植清单（14 个模块）

| 模块 | 行数 | 作用 | 依赖 | 接线位置 |
| --- | --- | --- | --- | --- |
| `anchor.js` | 132 | 尾部锚点：把身份与格式规则物理追加到 sections 末尾，抢 recency 位；子会话另有独立 context | 无 | `index.js` `applyHostHooks` + `identity.js` 装配改写 |
| `subagent-control.js` | 67 | 子代理审批接管：宿主给子会话写死 `approval/policy="never"`，先把 policy 翻成 `ask`，再在 waterfall 放行 | `anchor.js` | 同上 |
| `approval-takeover.js` | 110 | 审批服务接管：直接替换 `approval.decide()`，不依赖宿主静态补丁；顺带兜住「turn 边界外请求审批」的抛错 | 无 | 同上（`ctx.inject(["approval"])`） |
| `session-guard.js` | 145 | step 编号守卫：同 turn 内重复 `step/start` 会让宿主下次加载直接 `SessionFormatError`，这里在 append 层实时重编号 | 无 | 同上（`ctx.effect` + `session/created`） |
| `session-repair.js` | 292 | 会话日志体检 / 修复：解 zstd 帧、`normalizeSteps`、`repairSessionFile`（先 `.bak-<ts>` 再落盘） | 无 | `bin/repair-sessions.js` |
| `assemble-scrub.js` | 68 | 装配数组脏项清洗：上游把 `undefined` 混进 `sections/contexts` 时下游取 `.length` 就整条装配崩 | 无 | `index.js` 装配瀑布入口 |
| `refusal.js` | 424 | 拒答治理第 2 层：idle 后对整轮做「四联征」复核（无 tool call / 长度 / 双短语 / 无 usage，四取三），判为拒答就 followup 开新 turn | 无 | `index.js`（`agent/status`） |
| `refusal-prefix.js` | 267 | 拒答治理第 1 层：挂 `llm/stream`，开头几百字命中拒绝话术就掐断重跑，三档 nudge 递进 | `refusal.js`、`model-tuning.js` | 同上 |
| `model-tuning.js` | 141 | 按模型点名补丁：同一套正文，各厂商拒答句式不同，命中哪家只注入哪家 | 无 | 由 `refusal-prefix.js` 调用 |
| `web-reclaim.js` | 151 | 端口回收：反查监听者（netstat/lsof/ss）→ 校验命令行像 dsh web → 杀进程 | 无 | `restart-web.js` |
| `web-preflight-entry.js` | 167 | web preflight 的 sidecar：被复制进宿主 `lib/`，由 `bin.js` 顶部 import，Cordis 激活前回收孤儿 server | 无 | 由 `bin-preflight.js` 复制 |
| `bin-preflight.js` | 85 | 把上面那条 import 注入宿主 `bin.js`（原子写），并提供还原 | `desktop.js`、`hide-console.js` | `core.ensureHiddenConsole` / `core.revertCmdFlash` |
| `reanchor.js` | 146 | 漂移补丁的候选片段生成：给定原 pattern，按行归一化在宿主源码里重新定位并重建片段（只提案，不改 core） | 无 | `bin/reanchor.js` |
| `preset-default.js` | 205 | 停用/卸载时清掉指向本插件预设的 `selectedDefault`、删残留 agent 预设目录。宿主 `resolve()` 对未知预设是硬抛，不回退 `config.default` | `core.findDshHome` | `uninstall.js` |

---

## 三、改动过的既有文件（10 个）

| 文件 | 改动 |
| --- | --- |
| `lib/index.js` | +119 行：5 个 `install*` 接线（step-guard / approval-takeover / anchor+subagent / refusal 两层）、装配入口的 `scrubAssemble`、`anchorText` 传给装配改写、`anchorApplied` 从常量改为真实判定、社区版自身 `refusalRetry` 钩子加互斥门 |
| `lib/identity.js` | +17 行：`rewritePromptAssembly` 支持 `anchorText`，把锚点 section 物理追加到数组末尾并去重（`sp.section` 也注册了同名 section，不去重就是两份） |
| `lib/core.js` | +20 行：`ensureHiddenConsole` 增加 `preflight`，`revertCmdFlash` 增加 `revertBinPreflight`，返回值补 `preflight` 字段 |
| `lib/hide-console.js` | +13 行：补一个 `writeHostFileAtomic`（原文件没有这个导出，`bin-preflight.js` 依赖它） |
| `lib/uninstall.js` | +17 行：卸载流程补 `clearOwnedSelectedDefault` / `removeStaleAgentPresetDir` |
| `lib/restart-web.js` | +24 行：`waitFree()` 失败后按监听者反查再杀一次（只杀命令行像 dsh web 的进程） |
| `lib/tuning.js` | +16 行：新增 7 个 tuning 键 + 数值容错 |
| `lib/patches/index.mjs` | +3 行：挂上 `LEGACY_PATCHES` |
| `bin/community.js` | +9 行：`sessions` / `anchor-propose` 两个转发子命令 |
| `package.json` | bin 增加 `purge-sessions`、`purge-anchor`；scripts 增加 `test:ported`、`test:host` |

---

## 四、补丁表的变化

| 动作 | 内容 | 理由 |
| --- | --- | --- |
| **新增 #97** | `DESKTOP_HOST_SIGNAL_EXIT_LOG`（自有 #91 顺延） | 社区版 #91 已被 `BROWSER_COOKIE_NAME_IGNORE_PORT` 占用；标记 `silentWhenMissing: true`，锚点不在时记「跳过」而非「漂移」 |
| **不搬 #85/#86** | `SESSION_PROMPT_ALWAYS_FOLLOWUP`、`SESSION_QUEUE_STEER_INTERRUPT` | 与社区版 #90 `RESTORE_NATIVE_STEERING` 正面冲突。#90 主动撤销了这两条并把 `forbid` 写进合法性校验，搬过来必红 |
| **无需搬 #18/#19** | `REPEAT_TOOL_REMINDER_DISABLED`、`TOOL_RESULT_PRUNER_DISABLED` | **社区版 `lib/patches/opt-in.mjs` 早已包含这两条**（同为 opt-in、默认关闭）。这一条纠正了前期调研的误判 |

补丁总数：88 → **89**（`lib` 模块 116 → 131）；id 无重复，最大 #97。

---

## 五、新增开关

### 插件配置（`cordis.patch.yml` 的 `config:` 块，或 profile 内联配置）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `sessionGuard` | `true` | 会话 step 编号守卫 |
| `approvalTakeover` | `true` | 审批服务接管 |
| `subagentControl` | `true` | 子代理 policy 翻 ask + 放行 |
| `anchorMode` | `"tail"` | 尾部锚点；`"off"` 关闭 |
| `assembleScrub` | `true` | 装配脏项清洗 |
| `refusalGuard` | `true` | 拒答第 2 层 |
| `refusalPrefix` | `true` | 拒答第 1 层 |
| `modelTuning` | `true` | 按模型点名补丁 |
| `webReclaim` | `true` | 端口回收（重启辅助程序内生效） |
| `binPreflight` | `true` | 宿主 bin 前置检查 |

全部按 `!== false` 判定，写 `false` 即关闭，不需要卸载插件。

### `tuning.json`（`$DSH_HOME/dsh-purge/tuning.json`，改文件即生效）

`refusalGuard` / `refusalMax`（0–10，默认 2）/ `refusalText` / `refusalPrefix` / `refusalPrefixChars`（80–4000，默认 400）/ `modelTuning` / `modelTuningGeneric`

### 一个必须知道的互斥

社区版自己的 `refusalRetry`（带 `decompose` 的单次重试）和新的 `refusalPrefix` **都挂在 `llm/stream` 上**。代码里已强制互斥：`refusalPrefix` 开着时社区版那条不接管。想用社区版那条（最小可交付件模式），把 `refusalPrefix` 设 `false`，再把 `refusalRetry` 设 `true`。

---

## 六、明确没有搬的东西

| 项 | 原因 |
| --- | --- |
| `profile-insert.js`（14.8 KB） | 它写的是 `id: dsh-purge` 的 insert 块。社区版有自己的安装器（`install-registry.js` + `bootstrap-install.mjs`）负责 profile 落盘，两套并存会往同一个 `cordis.patch.yml` 写不同 id，属于制造冲突 |
| `apply-progress.js`（1.3 KB） | 内存进度表，只给自有版 `/dsh-purge/status` 轮询用。社区版没有消费方，搬来是死代码，已删除 |
| `default-prompt-inject.zh.md` / `.en.md` | 自有版的注入正文。社区版有自己的 `lib/default-prompt-inject.md` 与 `embed-prompt` 流程，两份正文不合并 |
| `stream-observation.js` | 社区版已有同名同职模块，不重复 |
| `lib/boost.js`（**同名，刻意保留社区版版本**） | 见下条，自有版的 `boost.js` 自 `v1.3.1` 起在 git 里是 base64，不可 import。社区版的是正常 JS，**本分支用的是社区版那份，未受影响** |
| 650 项测试 / 32 个 `check-*.mjs` | 绑社区版自己的模块边界，搬过来跑不动 |

> **关于 `boost.js` 的 base64 污染（2026-11-14 补充）**
>
> 自有分支 `v1.3.1` / `v1.3.2` 的 `lib/boost.js`（6,076B）与 `scripts/dev/boost.test.mjs`（4,100B）在仓库中即为单行 base64，宿主加载时报
> `failed to import: SyntaxError: Invalid or unexpected token`，表现为 purge 面板整块消失。
> 连带 `log-sample.test.mjs`、`status-version.test.mjs`（两者都 `import lib/index.js`）一起失败，`node --test` 总项数从 138 掉到 123。
>
> **本合并分支不受影响**：`lib/boost.js` 取自社区版（git blob 2,752B，正常 JS），迁移清单 14 个模块里也不含它。
> 但自有版那边需要单独修：见 `/e/BK/dsh-purge-audit` 分支 `fix/1.3.3-boost`（`9c40d44`，tag `v1.3.3`，本地未推送）。

---

## 七、验证结果

### 单元测试

```
npm run test:ported   →  69 项，69 通过，0 失败
npm test              →  668 项，599 通过，38 失败，31 跳过
```

**合并前后完全一致**：同样 668 项、599 通过、38 失败，失败清单逐条比对**零差异**。

那 38 条失败与本次合并无关，是环境依赖项（Windows 原生安装器、真实 curl/PowerShell 通道、Electron 换包、境外网络），在合并前的干净工作树上同样失败。对照方法：`git worktree add /e/BK/_base master` + 复制 `node_modules`，跑同一套测试。

### 装配冒烟

用最小假 ctx 跑 `module.apply()`（`DSH_HOME` 指向临时目录，不碰真实宿主），结果：

| 检查项 | 结果 |
| --- | --- |
| 装配是否抛错 | 否 |
| 注册的 section | `dsh-purge`、`dshpg-capabilities`、`dsh-purge-boost`、`dsh-purge:probe`、**`dsh-purge:anchor`** |
| 注册的 context | **`dsh-purge:child-anchor`** |
| 监听的事件 | `llm/stream`、`system-prompt/assemble`、`session/created`、`agent-preset/selected`、`agent/pre-step`、`session/event`、`approval/request`、`agent/request-error`、`agent/status` |
| 注入的服务 | `webServer`、`approval`、`commands` |
| 注册的工具 | `purge_status`、`purge_apply`、`purge_revert` |
| `ctx.effect` 注册数 | 19 |

逐条复验：`refusalPrefix.installed === true`；`installRefusalGuard` 返回 `{ dispose }`（该实现不返回 `installed` 标志，但 `agent/status` 已挂上）；`installSessionStepGuard` 幂等、无返回值（靠 `ctx.__dshPurgeStepGuardInstalled`）；`installSubagentControl` 返回 disposer。

### CLI

```
node bin/reanchor.js            → 没有 drifted 补丁（85 条全部 applied/na/skipped）
node bin/repair-sessions.js     → 找不到会话目录（DSH_HOME 未指向真实数据，属预期）
purge-community sessions/anchor-propose → 转发正常，退出码 0
```

---

## 八、怎么回退

分支只在本地，远端 `master` 未动。

```bash
git checkout master            # 回到 1.7.14 原样
git branch -D merge/popfbi-unique
```

要保留试验分支但不使用：

```bash
git checkout master
```

宿主侧无残留：本次合并**没有**执行任何 apply，所有 `install*` 都只在插件运行时生效，`bin-preflight` 与 `web-preflight-entry` 也只是文件就位，真正的注入发生在 `core.ensureHiddenConsole()` 被调用时（即 apply 流程）。

---

## 九、下一步（留给决定的人）

1. **先在真实宿主上跑一次** `purge-community status`，看 89 条补丁的 applied/drift 分布；#97 预期是 skipped。
2. **观察 `assemble.rewrite` 日志里的 `anchorApplied`** 是否恒为 `true`。为 `false` 说明宿主这一版的 sections 结构变了，锚点没进装配。
3. **决定推送形态**：直接推 `master`（替换 1.7.14）／推成 `master` 上的一个合并提交／只保留分支做实验，三种都由你定。
4. 若要发布，`package.json` 的 `version` 需要从 `1.7.14` 提到 `1.8.0`（有新增补丁 id 与新增 CLI），并补 `release-notes.md` 条目。
