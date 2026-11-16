'use strict';

const tools = require('./tools');

/**
 * 启动失败的自动修复：结束占用端口的进程、查占用者。
 * 只做用户明确同意后的动作，不主动杀进程。
 */

/** 解析 `netstat -ano -p tcp`，返回监听指定端口的 PID 列表。 */
function parseNetstat(output, port) {
  const target = Number(port);
  const pids = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i.exec(line);
    if (!match) continue;
    if (Number(match[1]) !== target) continue;
    const pid = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function findPortOwners(port, { exec = tools.defaultExec } = {}) {
  const result = await exec('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 15000 });
  if (!result.ok) return { ok: false, pids: [], error: result.error || result.stderr || 'netstat 执行失败' };
  return { ok: true, pids: parseNetstat(result.stdout, port), error: null };
}

async function killPids(pids, { exec = tools.defaultExec } = {}) {
  const results = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const result = await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
    results.push({
      pid,
      ok: result.ok,
      message: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
    });
  }
  return results;
}

module.exports = { parseNetstat, findPortOwners, killPids };
