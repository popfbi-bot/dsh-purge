// [merge:popfbi] 从自有分支 1.3.2 并入的补丁。原编号 #91，社区版 #91 已被
// BROWSER_COOKIE_NAME_IGNORE_PORT 占用，这里顺延为 #97（#97 起为合并分支保留段）。
export const LEGACY_PATCHES = [
  {
    // 自有分支 #194 的教训：host 被信号杀时补丁 #83 直接静默 resolve，UI 端永远不知道
    // host 已经没了，窗口自然不出现。这里保持"不弹对话框"，但把退出事实写进持久化日志，
    // 下次排查至少能看到 signal / code / stderr 尾巴。
    id: 97,
    name: "DESKTOP_HOST_SIGNAL_EXIT_LOG",
    layer: "代码",
    layer_en: "Code",
    desc: "host 被信号杀时写持久化退出日志（仍不弹对话框） / persist a trace when the host dies by signal",
    // 自有分支里这条已标 obsolete：锚点在 DSH NEXT 的 main.js 里 0 命中。
    // 保留它是因为旧版桌面端仍有这个分支；silentWhenMissing 让"锚点不在"记成
    // 跳过而不是漂移，免得新版宿主上平白多一条红字。
    silentWhenMissing: true,
    file: ["desktop-shell"],
    optional: true,
    skipIfMarked: true,
    replacements: [
      {
        pattern: "if (code === null || signal) { resolve(); return; }",
        replace:
          "if (code === null || signal) {\n" +
          "\t\t\t\t\t/* [dsh-purge] host signal exit logged */\n" +
          "\t\t\t\t\ttry {\n" +
          "\t\t\t\t\t\tconst _req = typeof require === \"function\" ? require : null;\n" +
          "\t\t\t\t\t\tconst _fs = typeof process.getBuiltinModule === \"function\" ? process.getBuiltinModule(\"node:fs\") : (_req ? _req(\"node:fs\") : null);\n" +
          "\t\t\t\t\t\tconst _os = typeof process.getBuiltinModule === \"function\" ? process.getBuiltinModule(\"node:os\") : (_req ? _req(\"node:os\") : null);\n" +
          "\t\t\t\t\t\tconst _log = _fs && _os ? _os.tmpdir() + \"/dsh-purge-desktop.log\" : \"\";\n" +
          "\t\t\t\t\t\tif (_log) _fs.appendFileSync(_log, new Date().toISOString() + \" [desktop.hostExit] signal=\" + String(signal) + \" code=\" + String(code) + suffix + \"\\n\", \"utf8\");\n" +
          "\t\t\t\t\t} catch {}\n" +
          "\t\t\t\t\tresolve(); return;\n" +
          "\t\t\t\t}",
      },
    ],
    markers: ["[dsh-purge] host signal exit logged"],
  },
];
