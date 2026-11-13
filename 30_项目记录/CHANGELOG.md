# 变更记录 — ds-session-cleanup

| 日期 | 文件 | 改了什么 | 为什么 |
| --- | --- | --- | --- |
| 2026-11-12 | `bin/sweep.js`、`lib/session-log.js` | 新建：多帧 zstd 会话日志解码 + 残留清理 CLI（附件/投影缓存/spill/billion-context/cost-meter） | DSH 的「删除会话」（archive-manager 1.3.1）只清会话目录与登记，附件、统计、缓存都不动 |
| 2026-11-12 | `bin/sweep.js` | 修附件 sha 拼接 bug：`sha = 目录前2位 + 文件名` → `sha = 文件名` | 文件名本身就是完整 sha256，拼接得到 `7272bf94…`，导致 3 个附件全被误判为孤儿（实测 2 个仍被存活会话引用） |
| 2026-11-12 | `bin/sweep.js` | 明细缓存改为“整文件移走让插件重算”，不再原地删 `shares` 条目 | 原地删会让缓存里的合计与按会话明细对不上 |
| 2026-11-12 | `bin/sweep.js` | spill 判定收紧：只认 `session-<uuid>`，短 id（如 `session-90056adf9527`）与非标准目录不动 | 短 id 无法可靠归属，可能误删当前会话的临时文件 |
| 2026-11-12 | `bin/sweep.js` | 实现 `--include-stray-sessions`（原先只提示“未实现”） | 让“未登记会话目录”在不加开关时只报告，加了才移入回收站 |
| 2026-11-12 | — | 真实 home 首次 `--apply --include-ledger`：120 项 / 1.76 MB 移入 `E:\dsh-home\trash\session-cleanup\20261112143058\`，0 失败 | 清掉已删会话「Pet插件出现两个大肥鱼」的残留；清理后 dry-run 归零 |
| 2026-11-12 | `README.md`、`SKILL.md` | 新建：缺口证据、判定规则、用法、技能化说明 | 让清理可复用、可交接 |
| 2026-11-12 | `lib/cleanup.js`、`bin/sweep.js` | 把扫描/执行逻辑抽到 `lib/cleanup.js`（`runSweep`），`bin/sweep.js` 改成薄 CLI；输出格式不变 | 插件要在进程内复用同一份逻辑，避免复制代码后两处漂移 |
| 2026-11-12 | `plugin/`（`package.json`/`cordis.patch.yml`/`index.js`/`locale`/`icon.svg`） | 新建宿主插件 `@local/dsh-session-cleanup` 1.0.0：监听 `api-session/removed`，去抖 800 ms 后 `runSweep({apply:true})`；启动 3 s 兜底扫一次；默认不动账本 | 用户选定“插件监听删除事件”自动化方案（m00477） |
| 2026-11-12 | `E:\dsh-home\profiles\desktop`（package.json、pnpm-lock、node_modules） | 修 pnpm store 错位：robocopy 旧 store 到 `E:\.pnpm-store\v11`，`CI=true` 重跑 `pnpm install`（295 包全部 hardlink 自 E 盘 store） | profile 从 `C:\Users\QI Lin\.dsh` 迁到 `E:\dsh-home` 后 `.modules.yaml` 仍指旧 store，`install_bundle` 报 `ERR_PNPM_UNEXPECTED_STORE` |
| 2026-11-12 | profile `package.json` | `@local/dsh-session-cleanup` 已加入 `dsh.profile.bundles` 与 `dependencies`（`link:E:/dsh-workspace/projects/ds-session-cleanup/plugin`） | `plugin_manager install_bundle` 写入；`application=restart-required`，重启后生效 |
| 2026-11-12 | `plugin/index.js` | 删掉裸 JSON Schema 的 `export const Config`，改由 `apply()` 内部处理默认值 | 重启后 `fiberPhase=failed`，diagnostic=`Cannot read properties of undefined (reading 'validate')`：cordis 要的是 schemastery `Schema`（带 `.validate`），裸对象会在挂载时炸；本插件没有需要 UI 编辑的配置，不导 Config 即可 |
| 2026-11-12 | — | 验证：`plugin_manager list_plugins` 里 `include:dsh-session-cleanup` → `fiberPhase=active`（`plugin_manager set_plugin` 关→开触发重载，无需再重启） | 插件已真正挂上，等一次真实删除做端到端验证 |
| 2026-11-12 | — | 端到端验证通过：新建会话 `session-e5e091ac-…`（贴了 2 张图）→ UI 删除 → 插件在 23:18:18 自动写出 `E:\dsh-home\trash\session-cleanup\20261112151817\journal.json`：21 项 / 502,872 B（孤儿附件 2 个 485,253 B + billion-context 分片 19 个 11,400 B），`failures: []`；删除后 dry-run 全 0 | 证明 `api-session/removed` → 去抖 → `runSweep` 整条链可用 |
| 2026-11-12 | — | 已知遗留（默认行为）：`includeLedger:false` 时不动 cost-meter。该测试会话仍留 `ledger.json` 1 行、`recent.json` 1 条、4 个 details-cache 文件里的按会话明细 | 在应用运行中改账本会被内存状态写回，所以默认关闭；需要时退出应用后手动 `--include-ledger` |
| 2026-11-12 | 回收站与临时目录 | 清空 `E:\dsh-home\trash\session-cleanup\` 下两份（2.27 MB）、`_trash\fixture_home`（2,055 文件 5.1 MB）、`_trash\202611122250_pnpm_fix`（5 文件）、`_trash\202611121403_pre-delete_84d1a98c`（818,689 B）、`_trash\probe.json`（86,022 B） | 用户逐项确认后清理；`_trash` 现为空 |
| 2026-11-12 | `plugin/lib/*.cjs`、`lib/*.js`、`bin/sweep.js`、`plugin/index.js`、`plugin/cordis.patch.yml`、`plugin/package.json` | **可移植改造（v1.1.0）**：清理核心移入 `plugin/lib/cleanup.cjs` + `session-log.cjs`（插件包自包含）；`lib/*.js` 变纯转发兼容层；插件按 `import.meta.url` 解析核心、去掉 `modulePath` 与 `home` 绝对路径，主目录改取 `DSH_HOME` → `~/.dsh`；CLI 增加 `--home`；`files` 增列 `lib/*.cjs` | 目标机路径与本机不同，原配置写死 `E:\dsh-workspace\...\lib\cleanup.js` 与 `E:\dsh-home`，直接拷过去必错 |
| 2026-11-12 | — | 验证可移植改造：CLI 预览 0 项（`--home` 与 `--json` 均正常）、插件 dry-run 无告警、`plugin_manager` 关→开后 `fiberPhase=active`；生成移植包 `documents\20261112_dsh会话删除自动清理_移植包_V1.0.zip` + `移植说明.md` | 复刻到另一台电脑只需三步且不改路径 |

## 待办

- [x] 决定自动化方式：插件监听 `api-session/removed`（已实现并安装）。
- [x] **重启 DSH 让插件激活**（已 active），实测删除测试会话自动清零（21 项 502,872 B）。
- [x] 清理临时目录与回收站（用户逐项确认，`_trash` 已空）。
- [x] 跑 `--apply` 的权限路径已验证：需 danger-full-access 或普通终端。
- [x] `E:\.pnpm-store\v11`（约 584 MB）成为正式 store，长期保留。
- [ ] 在另一台电脑按 `移植说明.md` 复刻，并回填一次“新机验证通过”的记录（尤其确认 `@michengai/dsh-archive-manager` 已装）。
