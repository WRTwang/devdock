'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { diagnoseStartFailure, detectSelfLaunch, portFromTail, excerptOf } = require('../electron/diagnose');
const { parseNetstat } = require('../electron/issuefix');

test('诊断：权限拒绝归为 elevate 自动修复', () => {
  const result = diagnoseStartFailure({
    exitCode: 1,
    elapsedMs: 1200,
    command: 'npm run dev',
    serviceName: 'API',
    tail: 'Error: EACCES: permission denied, open C:\\cache\n拒绝访问。 (0x5)',
  });
  assert.equal(result.id, 'permission');
  assert.equal(result.autoFix, 'elevate');
  assert.equal(result.elevate, true);
  assert.equal(result.suggestions.length > 0, true);
});

test('诊断：端口占用带出端口号并建议结束进程', () => {
  const result = diagnoseStartFailure({
    exitCode: 1,
    elapsedMs: 900,
    command: 'node server.js',
    serviceName: 'API',
    tail: 'Error: listen EADDRINUSE: address already in use :::3000',
  });
  assert.equal(result.id, 'port-in-use');
  assert.equal(result.port, 3000);
  assert.equal(result.autoFix, 'kill-port');
});

test('诊断：找不到命令', () => {
  const result = diagnoseStartFailure({
    exitCode: 1,
    tail: "'pnpm' 不是内部或外部命令，也不是可运行的程序",
    command: 'pnpm dev',
    serviceName: 'web',
  });
  assert.equal(result.id, 'command-not-found');
  assert.match(result.message, /pnpm dev/);
});

test('诊断：缺模块提示去环境体检', () => {
  const result = diagnoseStartFailure({
    exitCode: 1,
    tail: "Error: Cannot find module 'express'",
    command: 'node server.js',
  });
  assert.equal(result.id, 'module-missing');
  assert.equal(result.suggestions.some((text) => /环境体检/.test(text)), true);
});

test('诊断：数据库连不上', () => {
  const result = diagnoseStartFailure({
    exitCode: 1,
    tail: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    command: 'node server.js',
  });
  assert.equal(result.id, 'database-unreachable');
});

test('诊断：code=0 但启动后立即退出仍是警告', () => {
  const result = diagnoseStartFailure({
    exitCode: 0,
    elapsedMs: 800,
    command: 'npm start',
    serviceName: 'DevDock',
    tail: '> devdock@0.4.0 start\n> electron .\n[DevDock] 进程退出 (code=0)',
  });
  assert.equal(result.id, 'quick-exit');
  assert.equal(result.severity, 'warning');
});

test('诊断：非零退出码给通用错误', () => {
  const result = diagnoseStartFailure({ exitCode: 3, elapsedMs: 20000, tail: 'boom', command: 'node x' });
  assert.equal(result.id, 'exit-nonzero');
  assert.match(result.title, /3/);
});

test('诊断：日志摘录去掉 ANSI 与 DevDock 元信息，只留最后几行', () => {
  const tail = [
    '\u001b[31mERROR line 1\u001b[0m',
    '[DevDock] 进程退出 (code=1)',
    'ERROR line 2',
    'ERROR line 3',
  ].join('\n');
  const excerpt = excerptOf(tail, 2);
  assert.deepEqual(excerpt, ['ERROR line 2', 'ERROR line 3']);
});

test('portFromTail 从冒号形式提取端口', () => {
  assert.equal(portFromTail('listen EADDRINUSE :::5173'), 5173);
  assert.equal(portFromTail('no port here'), null);
});

test('detectSelfLaunch 识别 DevDock 自身', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-self-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'devdock', main: 'electron/main.js' }),
  );
  const blocked = detectSelfLaunch({ cwd: dir, command: 'npm start', appPath: dir });
  assert.ok(blocked);
  assert.equal(blocked.id, 'self-launch');

  const allowed = detectSelfLaunch({ cwd: dir, command: 'node worker.js', appPath: dir });
  assert.equal(allowed, null);
});

test('detectSelfLaunch 不误伤普通 Vite 项目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-vite-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }));
  assert.equal(detectSelfLaunch({ cwd: dir, command: 'npm run dev', appPath: path.join(os.tmpdir(), 'not-devdock') }), null);
});

test('parseNetstat 只挑指定端口的监听 PID', () => {
  const output = [
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321',
    '  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       8888',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:3000         127.0.0.1:5555         ESTABLISHED     1111',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(output, 3000), [4321, 9999]);
  assert.deepEqual(parseNetstat(output, 6379), []);
});
