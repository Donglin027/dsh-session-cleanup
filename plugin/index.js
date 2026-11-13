import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// 清理核心随包分发（plugin/lib/cleanup.js），不依赖任何机器上的绝对路径。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODULE = path.join(HERE, 'lib', 'cleanup.cjs');
// DSH 主目录：优先环境变量；未设则用 DSH 默认的 ~/.dsh（Windows 为 %USERPROFILE%\.dsh）
const DEFAULT_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export const inject = [];

// 注意：不要导出一个裸 JSON Schema 当 Config —— cordis 期望的是 schemastery 的 Schema
// 实例（带 .validate），裸对象会让 fiber 直接 failed（Cannot read properties of undefined
// (reading 'validate')）。这里不导 Config，默认值在 apply() 里处理。

/**
 * 会话残留清理插件。
 *
 * 触发点：archive-manager 永久删除会话后 `emit('api-session/removed', sessionId)`。
 * 不监听 `session/disposed`：那个事件在应用退出时也会触发。这里虽然同样会收到
 * 退出时的 removed，但定时器 unref，退出不会被拖住。
 */
export function apply(ctx, config = {}) {
  const home = config.home || DEFAULT_HOME;
  const modulePath = config.modulePath || DEFAULT_MODULE;
  const delayMs = Number.isFinite(config.delayMs) && config.delayMs >= 0 ? config.delayMs : 800;
  const includeLedger = config.includeLedger === true;
  const dryRun = config.dryRun === true;
  const sweepOnStart = config.sweepOnStart !== false;

  let core = null;
  let loadError = null;
  const load = () => {
    if (core) return core;
    if (loadError) throw loadError;
    try {
      const mod = require(modulePath);
      if (typeof mod.runSweep !== 'function') throw new Error('模块没有导出 runSweep：' + modulePath);
      core = mod;
      return core;
    } catch (e) {
      loadError = e;
      throw e;
    }
  };

  let timer = null;
  let running = false;
  let pendingReason = null;

  function schedule(reason, wait) {
    if (timer) clearTimeout(timer);
    pendingReason = reason;
    timer = setTimeout(() => {
      timer = null;
      const why = pendingReason || reason;
      pendingReason = null;
      run(why);
    }, wait == null ? delayMs : wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function run(reason) {
    if (running) {
      pendingReason = reason;
      return;
    }
    running = true;
    try {
      const { runSweep, size } = load();
      const report = runSweep({ home, apply: !dryRun, includeLedger });
      const { items, done, bytes } = report.totals;
      if (items > 0) {
        ctx.logger?.info?.(`session-cleanup: ${dryRun ? '发现' : '清理'} ${done || items}/${items} 项（${size(bytes)}），触发于 ${reason}`);
      }
      if (report.failures.length) {
        const sample = report.failures.slice(0, 3).map((f) => `${f.path} [${f.code}]`).join('; ');
        ctx.logger?.warn?.(`session-cleanup: ${report.failures.length} 项失败：${sample}`);
      }
    } catch (e) {
      ctx.logger?.warn?.(`session-cleanup: 清理失败（${home}）：${String((e && e.stack) || e)}`);
    } finally {
      running = false;
      if (pendingReason) {
        const why = pendingReason;
        pendingReason = null;
        schedule(why);
      }
    }
  }

  const off = ctx.on('api-session/removed', (sessionId) => {
    schedule('api-session/removed(' + String(sessionId) + ')');
  });

  if (sweepOnStart) schedule('startup sweep', Math.max(delayMs, 3000));

  return () => {
    try {
      if (timer) clearTimeout(timer);
    } catch { /* ignore */ }
    timer = null;
    try {
      off();
    } catch { /* ignore */ }
  };
}
