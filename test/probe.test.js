'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { checkPort, waitForPort } = require('../electron/probe');

function listen(port = 0) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('已监听的端口返回 true', async () => {
  const server = await listen();
  const { port } = server.address();
  try {
    assert.equal(await checkPort(port), true);
  } finally {
    server.close();
  }
});

test('未监听的端口返回 false', async () => {
  const port = await freePort();
  assert.equal(await checkPort(port, { timeoutMs: 300 }), false);
});

test('服务晚启动时能在超时前等到就绪', async () => {
  const port = await freePort();
  const serverPromise = new Promise((resolve) => {
    setTimeout(async () => resolve(await listen(port)), 400);
  });

  const result = await waitForPort(port, { timeoutMs: 5000, intervalMs: 100, checkTimeoutMs: 200 });
  const server = await serverPromise;
  server.close();

  assert.equal(result.ready, true);
  assert.ok(result.attempts >= 2);
  assert.ok(result.elapsedMs >= 300);
});

test('端口始终不监听时按超时返回 false', async () => {
  const port = await freePort();
  const result = await waitForPort(port, { timeoutMs: 600, intervalMs: 100, checkTimeoutMs: 100 });
  assert.equal(result.ready, false);
  assert.ok(result.elapsedMs >= 500);
  assert.ok(result.elapsedMs < 2500);
  assert.ok(result.attempts >= 2);
});

test('非法端口快速返回 false 而不挂起', async () => {
  const result = await waitForPort(0, { timeoutMs: 300, intervalMs: 50, checkTimeoutMs: 50 });
  assert.equal(result.ready, false);
});
