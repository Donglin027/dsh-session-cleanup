---
name: dsh-session-cleanup
description: 清理 DSH 里「已被删除的会话」留下的残留（孤儿附件、cost-meter 账本/明细、billion-context 分片）。当用户说“删了会话但磁盘没干净”“清掉已删会话的附件/统计”“做个删除后自动清理”，或需要核对某个 session id 是否还有残留时使用。
---

# DSH 会话残留清理

## 本机现状（先看这段，与源机器不同）

- **自动清理已装好**：宿主插件 `@local/dsh-session-cleanup` 在 desktop profile 里，`fiberPhase: active`。
  DSH 启动约 3 s 后自动扫一次；之后每次「删除会话」（archive-manager 永久删除并 `emit('api-session/removed')`）
  去抖 800 ms 自动扫一次。命中项只**移动**到 `C:\Users\1\.dsh\trash\session-cleanup\<YYYYMMDDHHmmss>\`，附带 `journal.json`。
- **`<CLEANUP_DIR>`** 在本机是 `C:\Users\1\dsh\workspace\tasks\配置部署\projects\ds-session-cleanup`。
- **本机 node 不在 PATH**：一律用 `bin\sweep.cmd`（自动优先用 DSH 自带 Node 24
  `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，再退回 PATH）。
- **插件是 junction 安装**：`~\.dsh\profiles\desktop\node_modules\@local\dsh-session-cleanup`
  → `<CLEANUP_DIR>\plugin`。移动/删除/改名这个项目目录，插件会立刻失效（不是拷贝，是链接）。

## 什么时候用

- 用户刚在 DSH 里删过会话（右键「删除会话」，由 `@michengai/dsh-archive-manager` 执行），想确认是否真的清干净。
- 用户抱怨 DSH 主目录（`DSH_HOME`，默认 `~/.dsh`；本机未设环境变量，即 `C:\Users\1\.dsh`）越来越大 / 附件占盘 /
  统计里还能看到已删会话。
- 用户要求“删除会话后自动清文件”（本机已在跑，先跑一次预览给证据，不要重复装）。

## 先讲清边界（回答用户第一句就说）

会话本体（`sessions\<slug>\session-<uuid>\`、投影缓存、spill、workspace 登记）由 archive-manager 的
「删除会话」负责，**不需要也不应该手工删**。本工具只补它没碰的部分：
附件孤儿、cost-meter 账本/明细、billion-context 分片。工作区里的业务文件不在范围内（多会话共享工作区，无法归属）。

## 步骤

1. 预览（只读，任何权限都能跑）：
   ```bat
   "<CLEANUP_DIR>\bin\sweep.cmd" --verbose
   ```
   （等价于 `node <CLEANUP_DIR>\bin\sweep.js --verbose`，只是自动找 node。）
2. 把结果翻成一句人话：命中几项、多大、分别是哪类；**逐项列出将被删除的绝对路径**。
   若“孤儿附件”里出现用户最近还在用的图片，先停下核对（它可能只被未落盘的进行中会话引用）。
3. 默认要用户确认后再执行（移入 `DSH_HOME\trash\session-cleanup\<stamp>\`，可回滚）；用户已明确要求“直接清”时可直接跑：
   ```bat
   "<CLEANUP_DIR>\bin\sweep.cmd" --apply --include-ledger
   ```
   DSH 主目录不是 `DSH_HOME` 或 `~/.dsh` 时，加 `--home "<主目录>"`。
4. 报结果：处理项数、释放空间、回收站路径、是否有失败项。有 `EPERM` 说明在沙箱里跑，提示用普通终端或提权。
5. 想让统计彻底一致，建议清理后重启一次 DSH（运行中的宿主可能把旧账本写回）。

## 硬规则

- 不加 `--apply` 绝不动文件；`--permanent` 只在用户明确说“不要回收站”时用。
- 只认 `session-<8-4-4-4-12>`；`dsh-pet` 等非标准 id 不碰。
- “存活”以磁盘上还有 `sessions\<slug>\session-<uuid>\session.v4.jsonl.zstd` 为准；归档会话仍在盘上，安全。
- 附件按引用计数判定：解压所有存活会话日志收集 `"attachmentId":"sha256:<64hex>"`，无人引用才清。
- 不重算 cost-meter 当日合计（`byProviderModel` 无法按会话归因），总额保留已删会话的花费。
- 不删 `C:\Users\1\dsh\workspace` 下任何文件；不碰 `storages\workspace.json`、`settings`、插件配置。
- 产物/日志不写患者信息、密钥；回收站清单里只留相对路径。

## 常见问题

- **预览说有 N 个未登记会话目录**：那是“磁盘有、`workspace.json` 没登记”的会话，默认只提示。用户确认后才加 `--include-stray-sessions`。
  - 本机这类目录里混着 4 个裸 uuid（`48ba45b9-…`、`53922d1f-…`、`99fb1dc7-…`、`b6f15a21-…`），
    是 **subagent 会话**（`origin":"subagent"`），天生不带 `session-` 前缀，被 `SESSION_ID_RE` 排除，属正常。
  - 已知小缺口：subagent 会话的 billion-context 分片（sessionId 为裸 uuid）永远不会被清；不影响附件安全，也不要手动改脚本去“修”。
- **账本改了但界面没变**：宿主内存里有旧账本，重启 DSH。
- **附件被判孤儿但用户说还在用**：看它是否只被“正在进行的会话”引用——进行中的会话日志可能还没落盘，此时不要 `--apply`。
- **启动后突然多了回收站目录**：正常，那是 `sweepOnStart: true` 的启动补扫；看 `journal.json` 的 `items` 就知道搬了什么。
- **要停用**：`plugin_manager` 里把 `include:dsh-session-cleanup` 置 `enabled: false`（profile 依赖保留即不会丢配置）；
  技能本身删 `%USERPROFILE%\.dsh\skills\dsh-session-cleanup\` 即可。
