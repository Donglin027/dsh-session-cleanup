#!/usr/bin/env node
'use strict';
/**
 * DSH 会话残留清理器（CLI，v2）
 *
 * 扫描逻辑与执行逻辑都在 ../lib/cleanup.js，本文件只负责：解析参数 → 调 runSweep → 打印。
 * 插件 @local/dsh-session-cleanup 复用同一个 runSweep，所以 CLI 与插件行为天然一致。
 *
 * 用法：
 *   node bin/sweep.js                        # 预览（默认不动文件）
 *   node bin/sweep.js --apply                # 移到 DSH_HOME\trash\session-cleanup\<时间戳>\
 *   node bin/sweep.js --apply --permanent    # 直接删（不进回收站）
 *   node bin/sweep.js --apply --include-ledger   # 连 cost-meter 账本/明细一起清
 *   node bin/sweep.js --json                 # 机器可读输出
 *
 * 环境变量：DSH_HOME（默认 E:\dsh-home）
 */
const path = require('path');
const os = require('os');
// 实现只保留在插件包里（plugin/lib/cleanup.js），这里引用它，保证 CLI 与插件行为一致。
const { runSweep, size } = require('../plugin/lib/cleanup.cjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const HOME = opt('home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const APPLY = flag('apply');
const PERMANENT = flag('permanent');
const INCLUDE_LEDGER = flag('include-ledger');
const INCLUDE_STRAY = flag('include-stray-sessions');
const JSON_OUT = flag('json');
const QUIET = flag('quiet');
const VERBOSE = flag('verbose');

const log = (m) => { if (!QUIET && !JSON_OUT) process.stdout.write(m + '\n'); };
const warn = (m) => process.stderr.write(m + '\n');

let report;
try {
  report = runSweep({
    home: HOME,
    apply: APPLY,
    permanent: PERMANENT,
    includeLedger: INCLUDE_LEDGER,
    includeStray: INCLUDE_STRAY,
    onLog: log,
    onWarn: warn,
  });
} catch (e) {
  warn('✗ 清理失败：' + (e && e.stack ? e.stack : e));
  process.exit(3);
}

for (const g of report.findings) {
  log('【' + g.title + '】' + g.count + ' 项，' + size(g.bytes));
  for (const it of g.items) {
    log('  - ' + size(it.bytes).padStart(9) + '  ' + it.rel + (it.edits ? ' edits=' + it.edits : ''));
    if (VERBOSE && it.reason) log('      reason: ' + it.reason);
  }
  if (!g.count) log('  （无）');
  log('');
}

if (report.straySessions.length) {
  log('【提示】' + report.straySessions.length + ' 个会话目录存在但未登记（不自动删）：');
  for (const s of report.straySessions) log('  - ' + s.id + '  ' + size(s.bytes));
  log('');
}

log('合计 ' + report.totals.items + ' 项，' + size(report.totals.bytes)
  + (INCLUDE_LEDGER ? '（含账本编辑）' : '（账本未处理，加 --include-ledger 一并进行）'));

if (!JSON_OUT) {
  log('');
  if (!APPLY) {
    log('（预览模式，未改动任何文件；确认后加 --apply）');
  } else {
    log('已处理 ' + report.totals.done + ' / ' + report.totals.items + ' 项，预计释放 ' + size(report.totals.bytes) + '。');
    if (PERMANENT) log('注意：本次为 --permanent，文件已直接删除。');
    else if (report.trash) log('被清内容已移到：' + report.trash);
    if (report.failures.length) {
      warn('');
      warn('✗ ' + report.failures.length + ' 项失败：');
      for (const f of report.failures.slice(0, 10)) warn('  ' + f.path + '  [' + f.code + '] ' + f.message);
      if (report.failures.some((f) => f.code === 'EPERM' || f.code === 'EACCES')) {
        warn('');
        warn('提示：当前会话处于工作区沙箱（workspace-write），对 ' + HOME + ' 的写操作被拒绝。');
        warn('      请在普通终端里运行，或用 danger-full-access 提权执行同一条命令。');
      }
    } else {
      log('无失败项。');
    }
    if (report.trash) log('清单：' + path.join(report.trash, 'journal.json'));
  }
}

if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (APPLY && report.failures.length) process.exitCode = 2;
