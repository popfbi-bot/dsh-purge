# 1.6.62 维护记录

## rc.5 证据

- 来源：`https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.5-mac-arm64.zip`（nightly feed，2026-10-29）。
- 方法：抽出 `app.asar` + `app.asar.unpacked`，对 `@deepseek-ai` 全树跑 `patchDrift`：`checked 82 / drifted 0`；`optionalDrift` 仅 #76（预设正文无需处理）；`missing` 仅第三方目标。
- 桌面壳：把 app 目录放成 `Resources/app` 后，#45/#46/#82/#83/#84 全部可应用。
- 边界：源码级零漂移 + 真实替换验证；运行时行为仍需用户在更新后跑 `selfcheck`/`diagnose` 确认。

## #107 判断依据

- `lib/identity.js` 只保留 `<|im_start|>system:`；`<|im_end|>` 仅出现在 `stripChatmlTags` 的删除分支。
- 宿主树 `@deepseek-ai/*` 检索：`im_start`、`im_end`、`project_instructions` 均为 0 处。
- 报告者日志 `anchorApplied=false 653/653`、`policy=fallback` 与「宿主无 ChatML 锚点」一致。
- 规则：成对信封保留；单边开标签删除；`<project_instructions>` 闭合保持不变。

## #91 / #92 来源

取自 PR #113 的 `lib/core.js` 两个补丁与 `client-connection` 目标；未采用该 PR 的重复发版与替换版发行说明。
