// 验证插件的「事件 → 去抖 → 清理核心」链路（dryRun，不写盘）
// 做法：先把 cleanup.cjs 的 runSweep 包一层计数，再看事件是否真的驱动它。
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const pluginDir = 'C:/Users/1/dsh/workspace/tasks/配置部署/projects/ds-session-cleanup/plugin';
const require = createRequire(import.meta.url);

const core = require(pluginDir + '/lib/cleanup.cjs');
const original = core.runSweep;
let calls = 0;
let lastOpts = null;
core.runSweep = (opts) => {
  calls += 1;
  lastOpts = opts;
  return original(opts);
};

const mod = await import(pathToFileURL(pluginDir + '/index.js').href);

const handlers = {};
const logs = [];
const logger = {
  info: (...a) => logs.push('[info] ' + a.join(' ')),
  warn: (...a) => logs.push('[warn] ' + a.join(' ')),
  error: (...a) => logs.push('[error] ' + a.join(' ')),
  debug: () => {},
};
const ctx = {
  on(name, fn) { handlers[name] = fn; return () => { delete handlers[name]; }; },
  logger,
};

const dispose = mod.apply(ctx, { dryRun: true, sweepOnStart: false, delayMs: 30 });
console.log('注册的事件:', Object.keys(handlers));
console.log('返回 dispose:', typeof dispose);

if (!handlers['api-session/removed']) {
  console.log('❌ 没有订阅 api-session/removed');
  process.exit(1);
}

// 连发三次，验证去抖（应只触发一次）
handlers['api-session/removed']('session-00000000-0000-4000-8000-000000000000');
handlers['api-session/removed']('session-11111111-1111-4111-8111-111111111111');
handlers['api-session/removed']('session-22222222-2222-4222-8222-222222222222');
await new Promise((r) => setTimeout(r, 2500));

console.log('runSweep 调用次数:', calls);
console.log('传入参数:', JSON.stringify(lastOpts));
console.log('--- 日志 ---');
for (const l of logs) console.log(l);
console.log('--- 判定 ---');
console.log(calls >= 1 ? '✅ 事件驱动了清理核心' : '❌ 事件没有驱动清理核心');
console.log(calls === 1 ? '✅ 连发三次只跑一次（去抖生效）' : `⚠️ 跑了 ${calls} 次`);
console.log(lastOpts && lastOpts.apply === false ? '✅ dryRun 时 apply=false（不动文件）' : '❌ apply 不是 false');

dispose();
console.log('dispose 后剩余事件:', Object.keys(handlers));
