'use strict';
/**
 * 清理核心：扫描并（可选）清除“已被删除的会话”留下的残留。
 *
 * 复用方：
 *   - bin/sweep.js（CLI，人工/定时）
 *   - dsh-session-cleanup 插件（监听 api-session/removed，删完立即清）
 *
 * 设计要点：
 *   - 全部同步实现，不依赖任何第三方包；
 *   - 默认“只扫描不动文件”，调用方显式传 apply；
 *   - 判定见 README：存活 = sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd 存在。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSessionLog, collectAttachmentIds } = require('./session-log.cjs');

const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function size(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function statSize(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    let t = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      t += e.isDirectory() ? statSize(q) : fs.lstatSync(q).size;
    }
    return t;
  } catch { return 0; }
}

function stampOf(d) {
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function loadOnDiskSessions(home) {
  const root = path.join(home, 'sessions');
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug);
    let isDir = false;
    try { isDir = fs.statSync(slugDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    for (const name of fs.readdirSync(slugDir)) {
      const dir = path.join(slugDir, name);
      const logFile = path.join(dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(logFile)) continue;
      map.set(name, { id: name, slug, dir, logFile, bytes: fs.statSync(logFile).size });
    }
  }
  return map;
}

function loadRegistry(home, onWarn) {
  const out = { live: new Set(), archived: new Set(), byWorkspace: [] };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    for (const [id, ws] of Object.entries((j.tables && j.tables.workspaces) || {})) {
      const raw = ws.sessionIds;
      const ids = Array.isArray(raw) ? raw : String(raw || '').split(/\s+/).filter(Boolean);
      ids.forEach((x) => out.live.add(x));
      out.byWorkspace.push({ id, path: ws.path, count: ids.length });
    }
    for (const x of (j.global && j.global.archivedSessionIds) || []) out.archived.add(x);
  } catch (e) {
    onWarn('⚠ 读不到 workspace.json：' + e.message);
  }
  return out;
}

function listAttachmentObjects(home) {
  const root = path.join(home, 'attachments', 'v1', 'objects');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const a of fs.readdirSync(root)) {
    const d = path.join(root, a);
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    for (const b of fs.readdirSync(d)) {
      const p = path.join(d, b);
      // 文件名本来就是完整 sha256，目录名只是它的前 2 位；不能拼接，否则会得到 7272bf94… 这种双前缀。
      const sha = /^[0-9a-f]{64}$/i.test(b) ? b.toLowerCase() : (a + b).toLowerCase();
      out.push({ sha, path: p, rel: path.join('attachments', 'v1', 'objects', a, b), bytes: fs.statSync(p).size });
    }
  }
  return out;
}

function listBillionContext(home) {
  const bc = path.join(home, 'storages', 'cost-meter', 'ledger.json.billion-context');
  const out = [];
  if (!fs.existsSync(bc)) return out;
  for (const sub of ['groups', 'streams', 'calls']) {
    const dir = path.join(bc, sub);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      const st = fs.statSync(p);
      const files = st.isDirectory() ? fs.readdirSync(p).map((x) => path.join(p, x)) : [p];
      for (const fp of files) {
        let texts;
        try { texts = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim()); } catch { continue; }
        const ids = new Set();
        for (const line of texts) {
          const m = line.match(/"sessionId"\s*:\s*"([^"]+)"/);
          if (m) ids.add(m[1]);
        }
        out.push({
          path: fp,
          rel: path.relative(home, fp),
          bytes: fs.statSync(fp).size,
          sessionIds: [...ids],
          lines: texts.length,
        });
      }
    }
  }
  return out;
}

function moveToTrash(trash, absPath, relPath) {
  const dest = path.join(trash, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(absPath, dest); return dest; }
  catch {
    fs.cpSync(absPath, dest, { recursive: true });
    fs.rmSync(absPath, { recursive: true, force: true });
    return dest;
  }
}

/**
 * 扫描（并在 apply 时清理）残留。
 *
 * @param {object} opts
 * @param {string} opts.home        DSH_HOME
 * @param {boolean} [opts.apply]    真的要动文件
 * @param {boolean} [opts.permanent] 直接删，不进回收站
 * @param {boolean} [opts.includeLedger] 连 cost-meter 账本/明细一起处理
 * @param {boolean} [opts.includeStray]  连“未登记会话目录”一起移入回收站
 * @param {string}  [opts.trashRoot] 回收站根，默认 <home>\trash\session-cleanup
 * @param {(m:string)=>void} [opts.onLog]
 * @param {(m:string)=>void} [opts.onWarn]
 * @param {Date} [opts.now]
 * @param {string[]} [opts.strayAllowList] 只清这些 id 的未登记目录（插件按事件调用时用）
 */
function runSweep(opts) {
  const home = opts.home;
  const onLog = opts.onLog || (() => {});
  const onWarn = opts.onWarn || (() => {});
  const apply = Boolean(opts.apply);
  const permanent = Boolean(opts.permanent);
  const includeLedger = Boolean(opts.includeLedger);
  const includeStray = Boolean(opts.includeStray);
  const now = opts.now || new Date();
  const stamp = stampOf(now);
  const trash = opts.trashRoot ? path.join(opts.trashRoot, stamp) : path.join(home, 'trash', 'session-cleanup', stamp);
  const allowStray = opts.strayAllowList ? new Set(opts.strayAllowList) : null;

  const failures = [];
  const findings = {
    attachments: [], projcache: [], spill: [], billionContext: [], ledger: [], straySessions: [],
  };

  const onDisk = loadOnDiskSessions(home);
  const registry = loadRegistry(home, onWarn);
  const isDead = (id) => SESSION_ID_RE.test(id) && !onDisk.has(id);

  onLog('DSH_HOME = ' + home);
  onLog('已存盘会话 = ' + onDisk.size + '（' + [...onDisk.keys()].map((x) => x.slice(8, 16)).join(', ') + '）');
  onLog('登记会话 = ' + registry.live.size + '，归档 ' + registry.archived.size);
  onLog('');

  // ---- A. 附件孤儿：没有任何存活会话引用 ----
  const referenced = new Set();
  let decoded = 0, decodeErrors = 0, logBytes = 0;
  for (const s of onDisk.values()) {
    try {
      const { lines, bytes, error } = readSessionLog(s.logFile);
      logBytes += bytes;
      decoded++;
      if (error) decodeErrors++;
      for (const id of collectAttachmentIds(lines)) referenced.add(id);
    } catch (e) {
      decodeErrors++;
      onWarn('⚠ 解不开 ' + s.logFile + '：' + e.message);
    }
  }
  onLog('已解码 ' + decoded + ' 份会话日志（' + size(logBytes) + '），引用到 ' + referenced.size + ' 个附件' + (decodeErrors ? '，' + decodeErrors + ' 份失败' : ''));
  for (const o of listAttachmentObjects(home)) {
    if (!referenced.has(o.sha)) {
      findings.attachments.push({ ...o, reason: 'no live session references this object' });
    }
  }

  // ---- B. 投影缓存孤儿 ----
  const pcDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  if (fs.existsSync(pcDir)) {
    for (const f of fs.readdirSync(pcDir)) {
      const m = f.match(/^(session-[0-9a-f-]{36})\.json$/i);
      if (!m) continue;
      if (onDisk.has(m[1])) continue;
      const p = path.join(pcDir, f);
      findings.projcache.push({ path: p, rel: path.relative(home, p), bytes: fs.statSync(p).size, reason: 'session directory is gone' });
    }
  }

  // ---- C. spill 临时目录 ----
  let spillRoots = [];
  try {
    spillRoots = fs.readdirSync(os.tmpdir())
      .filter((x) => x.startsWith('dsh-spill-'))
      .map((x) => path.join(os.tmpdir(), x));
  } catch (e) { onWarn('⚠ 读不到临时目录：' + e.message); }
  for (const root of spillRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) { onWarn('⚠ 读不到 spill 目录 ' + root + '：' + e.message); continue; }
    for (const e of entries) {
      const p = path.join(root, e);
      // 只处理标准会话 id；spill 里还可能出现短 id（如本会话的 session-90056adf9527）或其它插件目录，
      // 无法可靠归属，一律不动。
      if (!SESSION_ID_RE.test(e)) continue;
      if (onDisk.has(e)) continue;
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      findings.spill.push({ path: p, rel: path.join('spill', path.basename(root), e), bytes: statSize(p), reason: 'session directory is gone' });
    }
  }

  // ---- D. billion-context 按会话分片 ----
  for (const f of listBillionContext(home)) {
    const managed = f.sessionIds.filter((x) => SESSION_ID_RE.test(x));
    if (!managed.length) continue;
    if (managed.every(isDead)) {
      findings.billionContext.push({ ...f, reason: 'all records belong to deleted sessions' });
    }
  }

  // ---- E. cost-meter 账本与明细（需 includeLedger）----
  if (includeLedger) {
    const cm = path.join(home, 'storages', 'cost-meter');
    const recent = path.join(cm, 'ledger.json.details-cache', 'recent.json');
    if (fs.existsSync(recent)) {
      try {
        const j = JSON.parse(fs.readFileSync(recent, 'utf8'));
        const before = (j.sessions || []).length;
        j.sessions = (j.sessions || []).filter((s) => !isDead(s.sessionId || ''));
        if ((j.sessions || []).length !== before) {
          findings.ledger.push({ path: recent, rel: path.relative(home, recent), bytes: fs.statSync(recent).size, kind: 'json-edit', reason: 'drop recent-session rows of deleted sessions', edits: before - j.sessions.length, payload: j });
        }
      } catch (e) { onWarn('⚠ recent.json 解析失败：' + e.message); }
    }
    const dcDir = path.join(cm, 'ledger.json.details-cache');
    if (fs.existsSync(dcDir)) {
      for (const f of fs.readdirSync(dcDir)) {
        if (!f.endsWith('.json') || f === 'recent.json') continue;
        const p = path.join(dcDir, f);
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        // 明细缓存是按参数哈希命名的聚合结果：原地删条目会让「合计」与「按会话明细」对不上，
        // 所以整文件移走让插件重算（缓存本身可再生，不需要保留）。
        let hits = 0;
        for (const m of text.matchAll(/"sessionId"\s*:\s*"(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi)) {
          if (isDead(m[1])) hits++;
        }
        if (hits) {
          findings.ledger.push({ path: p, rel: path.relative(home, p), bytes: fs.statSync(p).size, reason: 'detail cache contains rows of deleted sessions (whole file dropped so it is recomputed)', edits: hits });
        }
      }
    }
    const ledger = path.join(cm, 'ledger.json');
    if (fs.existsSync(ledger)) {
      try {
        const j = JSON.parse(fs.readFileSync(ledger, 'utf8'));
        let edits = 0;
        for (const date of Object.keys(j.days || {})) {
          const day = j.days[date];
          if (Array.isArray(day.sessions)) {
            const before = day.sessions.length;
            day.sessions = day.sessions.filter((s) => !isDead(s.id || ''));
            edits += before - day.sessions.length;
          }
        }
        if (edits) findings.ledger.push({ path: ledger, rel: path.relative(home, ledger), bytes: fs.statSync(ledger).size, kind: 'json-edit', reason: 'drop daily session rows of deleted sessions', edits, payload: j, note: 'day totals are NOT recomputed (byProviderModel cannot be attributed)' });
      } catch (e) { onWarn('⚠ ledger.json 解析失败：' + e.message); }
    }
  }

  // ---- F. 磁盘上有目录但登记表里没有 ----
  for (const s of onDisk.values()) {
    if (registry.live.has(s.id) || registry.archived.has(s.id)) continue;
    if (allowStray && !allowStray.has(s.id)) continue;
    findings.straySessions.push({ path: s.dir, rel: path.relative(home, s.dir), bytes: s.bytes, id: s.id, reason: 'on disk but not registered' });
  }

  const groups = [
    ['孤儿附件', findings.attachments],
    ['孤儿投影缓存', findings.projcache],
    ['孤儿 spill 目录', findings.spill],
    ['billion-context 已删会话分片', findings.billionContext],
    ['cost-meter 账本/明细条目', findings.ledger],
  ];

  let done = 0;
  if (apply) {
    const all = [
      ...findings.attachments,
      ...findings.projcache,
      ...findings.spill,
      ...findings.billionContext,
      ...findings.ledger,
      ...(includeStray ? findings.straySessions : []),
    ];
    for (const it of all) {
      try {
        if (it.kind === 'json-edit') {
          const backup = path.join(trash, it.rel);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(it.path, backup);
          fs.writeFileSync(it.path, JSON.stringify(it.payload));
          done++;
          continue;
        }
        if (permanent) {
          fs.rmSync(it.path, { recursive: true, force: true });
        } else {
          moveToTrash(trash, it.path, it.rel);
        }
        done++;
      } catch (e) {
        failures.push({ path: it.path, code: e.code || 'ERROR', message: e.message });
      }
    }
  }

  const totals = {
    items: groups.reduce((a, [, l]) => a + l.length, 0),
    bytes: groups.reduce((a, [, l]) => a + l.reduce((x, y) => x + y.bytes, 0), 0),
  };

  const report = {
    home, applied: apply, permanent, includeLedger, includeStray,
    stamp,
    onDiskSessions: [...onDisk.keys()],
    registry: { live: registry.live.size, archived: registry.archived.size },
    decoded: { logs: decoded, errors: decodeErrors, bytes: logBytes, attachmentsReferenced: referenced.size },
    findings: groups.map(([title, list]) => ({
      title,
      count: list.length,
      bytes: list.reduce((a, x) => a + x.bytes, 0),
      items: list.map((x) => ({ rel: x.rel, bytes: x.bytes, reason: x.reason, edits: x.edits })),
    })),
    straySessions: findings.straySessions,
    totals: { ...totals, done },
    failures,
    trash: apply && !permanent ? trash : null,
  };

  if (apply && done) {
    try {
      fs.mkdirSync(trash, { recursive: true });
      fs.writeFileSync(path.join(trash, 'journal.json'), JSON.stringify({
        stamp, home, permanent, includeLedger,
        items: groups.flatMap(([title, l]) => l.map((x) => ({ title, rel: x.rel, bytes: x.bytes, reason: x.reason, edits: x.edits }))),
        failures,
      }, null, 2));
    } catch (e) { onWarn('⚠ 写清单失败：' + e.message); }
  }

  return report;
}

module.exports = { runSweep, size, SESSION_ID_RE };
