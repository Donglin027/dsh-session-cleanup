# ds-session-cleanup — DSH 会话“删除后残留”清理器

解决一个具体问题：**在 DSH 里删掉会话后，这个会话留下的附件、统计与缓存并没有全部消失**。

DSH 本身没有“删除会话”，右键菜单里的「删除会话」来自已安装的社区插件
`@michengai/dsh-archive-manager`（本机 1.3.1）。它删除的是：

- `sessions\<工作区slug>\session-<uuid>\`（整目录，含 `session.v4.jsonl.zstd`）
- `storages\session_projcache\sessions\session-<uuid>.json`
- `storages\workspace.json` 里的会话登记
- `%TMP%\dsh-spill-*\session-<uuid>\`（临时 spill）
- 归档索引

它**没有**处理的（在 `lib/workspace.js` 里全库搜 `attachment` 零命中，没有任何 cost-meter 代码）：

| 残留 | 位置 | 影响 |
| --- | --- | --- |
| 该会话上传/粘贴的附件 | `attachments\v1\objects\<前2位>\<sha256>` | 永久占盘，且宿主没有附件 GC |
| 会话级的成本统计行 | `storages\cost-meter\ledger.json` 的 `days[].sessions[]` | 统计里仍能看到已删会话 |
| 最近会话列表 | `storages\cost-meter\ledger.json.details-cache\recent.json` | 同上 |
| 明细缓存 | `storages\cost-meter\ledger.json.details-cache\<sha256>.json` | 缓存里的按会话明细仍是旧的 |
| billion-context 分片 | `storages\cost-meter\ledger.json.billion-context\{groups,streams,calls}\` | 每个分片带 `sessionId`，删会话后成孤儿 |

实测：删掉「Pet插件出现两个大肥鱼」后，插件自身清掉约 799 KB，但留下 1 个 675.5 KB 的附件孤儿、
`ledger.json` 中 3 处、4 个明细缓存文件里的按会话条目、`recent.json` 记录，以及 billion-context 里的分片。
插件确认框写的是“将永久删除…全部记录（对话内容、统计、缓存）”，与实现不符——本工具就是补这个缺口。

## 安装

```bat
:: 从 GitHub Release 的 tarball 安装（v1.1.0，含 Cordis 插件包，无运行时依赖）
dsh plugin --profile desktop add "https://github.com/Donglin027/dsh-session-cleanup/releases/download/v1.1.0/dsh-session-residue-cleanup-1.1.0.tgz"
```

装完**重启 DSH** 生效；设置 → 插件里能看到「会话残留清理」。
也可以直接用仓库装：`dsh plugin --profile desktop add github:Donglin027/dsh-session-cleanup`。

## 快速使用

```bat
:: 1. 预览（默认，不动任何文件）
node projects\ds-session-cleanup\bin\sweep.js

:: 2. 真删：移到 DSH_HOME\trash\session-cleanup\<时间戳>\，可回滚
node projects\ds-session-cleanup\bin\sweep.js --apply

:: 3. 连成本账本/明细一起清（会先备份再改写 JSON）
node projects\ds-session-cleanup\bin\sweep.js --apply --include-ledger

:: 4. 机器可读
node projects\ds-session-cleanup\bin\sweep.js --json
```

`DSH_HOME` 取环境变量 `DSH_HOME`，未设则用 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`）。

## 自动模式（插件，推荐）

装好本地插件后，**在 UI 里删会话就会自动清残留**，不用再手动跑命令。

- 插件包：`plugin\`（本地 link 装的是 `@local/dsh-session-cleanup` 1.1.0，发布包名 `dsh-session-residue-cleanup`），监听宿主的 `api-session/removed` 事件
  —— archive-manager 删完会话才发这个事件，所以不会抢跑。
- 行为：事件到达后去抖 800 ms，再调用 `plugin\lib\cleanup.cjs` 的 `runSweep({apply:true})`；
  默认**不动账本**（`includeLedger: false`），需要连账本一起清就改配置。
- 启动兜底：应用启动 3 s 后也扫一次（`sweepOnStart: true`），补上“删会话时应用崩了”的漏网项。
- 配置（`plugin\cordis.patch.yml` 的 `config`）：`home`、`modulePath`（可选，覆盖清理核心路径）、
  `includeLedger`、`delayMs`、`sweepOnStart`、`dryRun`。改完重启 DSH 生效。
- 安装/升级：`plugin_manager install_bundle`，target 指 `plugin\` 目录；装完 `application=restart-required`，**重启 DSH 才激活**。
  设置 → 插件里能看到「会话残留清理」。
- 注意：v1.1.0 起清理核心随包分发（`plugin\lib\cleanup.cjs`），按 `import.meta.url` 解析，**项目换位置不用改配置**。
- 注意：插件**不导出 `Config`**。cordis 的 Config 必须是 schemastery 的 `Schema` 实例（带 `.validate`），
  导出裸 JSON Schema 会让 fiber 直接 `failed`（`Cannot read properties of undefined (reading 'validate')`）；
  配置照旧写在 `cordis.patch.yml` 的 `config:` 下，只是设置页里没有可视化表单。

## 技能（任意会话可用）

已装成技能：`%DSH_HOME%\skills\dsh-session-cleanup\SKILL.md`（技能名 `dsh-session-cleanup`）。
以后在任意会话里说“清一下已删会话的残留”，助手会按同一套流程走：先预览、逐项核对、再 `--apply`。

| 开关 | 作用 |
| --- | --- |
| `--apply` | 真执行；不加就是 dry-run |
| `--permanent` | 跳过回收站直接删（不可恢复，慎用） |
| `--include-ledger` | 一并清理 cost-meter 的账本与明细缓存 |
| `--include-stray-sessions` | 把“磁盘上有会话目录但没登记”的目录也移入回收站（默认只提示） |
| `--json` / `--quiet` / `--verbose` | 输出控制 |

## 判定规则（安全边界）

1. **存活 = 磁盘上还有 `sessions\<slug>\session-<uuid>\session.v4.jsonl.zstd`**。
   归档会话仍留在磁盘上，所以“归档”不会被误判为“已删”。
2. 只承认 `session-<8-4-4-4-12>` 形态的 id。`dsh-pet` 这类非标准 id 一律不碰（避免误删 pet 插件数据）。
3. 附件按“引用计数”判定：解压所有存活会话的日志，收集 `"attachmentId":"sha256:<64hex>"`；
   只有**没有任何存活会话引用**的对象才会被清。同一对象被多条会话共用时安全。
4. billion-context 分片只有**全部记录都属于已删会话**时整文件移走；混合分片不动。
5. 明细缓存按“整文件移走让插件重算”处理：原地删条会让缓存里的合计与明细对不上。
6. 账本只删 `days[].sessions[]` 里已删会话的行，**不重算当天合计**（`byProviderModel` 无法按会话归因），
   所以“总额”仍包含已删会话花掉的钱——这是有意保留的账实一致。
7. 不碰工作区里的任何项目文件。DSH 的多条会话共用同一个工作区，工作区目录下的文件无法按会话归属，
   所以本工具只清 DSH_HOME 内的元数据与附件，不动工作区。
8. 默认移入 `DSH_HOME\trash\session-cleanup\<stamp>\`（保持相对路径），并写 `journal.json` 记录每一项。
9. 改 JSON 前先把原文件复制进回收站；改写失败则跳过，不影响其余项。

## 输出示例

```
已存盘会话 = 4（f8917732, 38245582, 868ddfae, fdc0b02e）
登记会话 = 3，归档 0
已解码 4 份会话日志（2.95 MB），引用到 2 个附件
【孤儿附件】1 项，675.5 KB
  -  675.5 KB  attachments\v1\objects\d5\d5af61f1…5d0597ed
【billion-context 已删会话分片】113 项，68.3 KB
【cost-meter 账本/明细条目】6 项，943.7 KB
合计 120 项，1.65 MB（含账本编辑）
```

## 实现要点

- `plugin/lib/session-log.cjs`：DSH 会话日志是**逐次追加的多帧 zstd**，Node 的 `zlib.zstdDecompressSync`
  和流式解压都只解第一帧，必须按 zstd 帧头手工走边界逐帧解压（magic `0xFD2FB528`、
  FHD 的 fcsFlag/singleSegment/checksum/dictFlag、3 字节 block header）；`readSessionLog()` 返回
  `{bytes,frames,lines,error,tail}`，`tail>0` 说明末帧不完整（会话正在写），只影响该会话的引用收集。
- `plugin/lib/cleanup.cjs`：扫描与执行的核心，导出 `runSweep(options)`。返回结构化报告
  （`findings[].items[]`、`totals`、`failures`、`trash`），CLI 与插件共用同一份逻辑。
- `bin/sweep.js`：薄 CLI（参数解析 + 打印），直接 `require('../plugin/lib/cleanup.cjs')`；支持
  `--home <dir>` 覆盖 DSH 主目录，默认取 `DSH_HOME` 环境变量、否则 `~/.dsh`。
- `lib/cleanup.js`、`lib/session-log.js`：兼容层，只做转发，避免两份实现。
- `plugin/`：宿主插件包（ESM + `cordis.patch.yml` + locale + icon + `lib/*.cjs` 核心），**自包含**：
  核心随包分发，插件按自身位置解析，不含任何绝对路径，可整体拷到别的机器。
- 包内文件是 `.cjs` 的原因：插件包 `package.json` 是 `"type":"module"`，同目录 `.js` 会被当 ESM，
  CommonJS 核心必须用 `.cjs` 后缀才能被 `require`。
- 沙箱提示：在 DSH 的 `workspace-write` 沙箱里运行 `--apply` 会 `EPERM`（DSH_HOME 在工作区外），
  工具会提示改用普通终端或提权。dry-run 只读，任何权限下都能跑。

## 移植到另一台电脑

前置：目标机 DSH 里已装 `@michengai/dsh-archive-manager`（提供「删除会话」菜单与 `api-session/removed`
事件）。验证方法：右键任一会话，菜单里有「删除会话」。

1. 把整个 `ds-session-cleanup` 目录拷到目标机（建议 `<工作区>\projects\ds-session-cleanup`）。
2. 让目标机的 DSH 助手执行 `plugin_manager install_bundle`，`target` 指向 `<...>\ds-session-cleanup\plugin`；
   若返回 `restart-required`，重启 DSH，或在插件面板把「会话残留清理」关→开重载。
3. 复制 `skill\dsh-session-cleanup\SKILL.md`（移植包内附）到 `%DSH_HOME%\skills\dsh-session-cleanup\SKILL.md`。
4. 验证：`node bin\sweep.js` 预览（应 0 项或列出真实残留）→ 新建会话并删除 → 看
   `%DSH_HOME%\trash\session-cleanup\<时间戳>\journal.json` 是否自动出现。

细节见 [移植说明.md](移植说明.md)。

## 已做的验证

- 真实 home dry-run：命中 120 项 1.65 MB，修复了“附件 sha 前缀重复拼接”导致的误判（全部 3 个对象都当孤儿）。
- 真实 home `--apply --include-ledger`：120/120 项成功、0 失败，回收站 121 个文件 1,763,458 B；复跑预览归零。
- 假 home（`_trash\fixture_home`，复制真实日志/附件/账本）跑 `--apply --include-ledger`：
  496/496 项成功、0 失败，回收站 497 文件 1,243,380 B；只删掉无人引用的附件对象；活跃会话的附件与
  projcache 保留；账本与 recent.json 中已删会话的行被移除；明细缓存整文件移入回收站。
- 插件冒烟测试（真实安装目录）：只注册 `api-session/removed`，dispose 能解绑；locale/icon/patch 都在。
- 单独验证 spill 判定（死 id 目录被清、短 id 目录与非标准目录不动）。

## 局限

- 不能阻止“删除会话时宿主/插件自身写回”。若清理时 DSH 正在运行且内存里有旧账本，插件可能覆盖回部分统计；
  建议清理后重启一次 DSH 再看统计。
- 附件是内容寻址的，若某对象同时被“已删会话”和别的程序引用（例如手动塞进 objects 的文件），
  本工具会因为“无会话引用”而收走；只会进回收站，可恢复。
- 会话产生的业务文件（导出物、脚本产物）在共享工作区里，**不在清理范围内**。

## License

MIT License，见 [LICENSE](LICENSE)。Copyright (c) 2026 Donglin027
