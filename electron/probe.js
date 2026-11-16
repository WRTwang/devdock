'use strict';

const net = require('node:net');

/**
 * 单次探测 TCP 端口是否可连接。
 */
function checkPort(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      resolve(false);
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(numeric, host);
  });
}

/**
 * 轮询等待端口就绪（用于数据库 / 后端启动门控）。
 * @returns {{ ready: boolean, elapsedMs: number, attempts: number }}
 */
async function waitForPort(port, options = {}) {
  const { host = '127.0.0.1', timeoutMs = 30000, intervalMs = 500, checkTimeoutMs = 1000 } = options;
  const started = Date.now();
  let attempts = 0;

  while (true) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;

    attempts += 1;
    const ok = await checkPort(port, { host, timeoutMs: Math.min(checkTimeoutMs, remaining) });
    if (ok) return { ready: true, elapsedMs: Date.now() - started, attempts };

    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }

  return { ready: false, elapsedMs: Date.now() - started, attempts };
}

module.exports = { checkPort, waitForPort };
