'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInvocation, Runner } = require('../electron/runner');

test('cmd 调用带 UTF-8 代码页前缀', () => {
  const { file, args } = buildInvocation('cmd', 'npm run dev');
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(args[3], /chcp 65001/);
  assert.match(args[3], /npm run dev$/);
});

test('powershell 调用带输出编码与执行策略', () => {
  const { file, args } = buildInvocation('powershell', 'npm run dev');
  assert.equal(file, 'powershell.exe');
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('Bypass'));
  assert.match(args[args.length - 1], /OutputEncoding/);
});

test('空命令会抛错', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const runner = new Runner({ logRoot });
  assert.throws(() => runner.exec({ id: 'x', dir: logRoot, shell: 'cmd' }, { command: '  ', kind: 'start' }), /还没有配置/);
});

test('项目目录不存在会抛错', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const runner = new Runner({ logRoot });
  assert.throws(
    () =>
      runner.exec(
        { id: 'x', dir: path.join(os.tmpdir(), 'devdock-missing-xyz'), shell: 'cmd', envVars: [] },
        { command: 'echo 1', kind: 'start' },
      ),
    /目录不存在/,
  );
});

test('真实执行命令并捕获退出状态', async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-run-'));
  const events = [];
  const runner = new Runner({
    logRoot,
    onLog: (payload) => events.push(payload),
    onState: (payload) => events.push(payload),
  });

  const { child } = runner.exec(
    { id: 'demo', dir: workDir, shell: 'cmd', envVars: [{ key: 'DEVDOCK_TEST_FLAG', value: 'yes' }] },
    { command: 'echo %DEVDOCK_TEST_FLAG%', kind: 'start' },
  );

  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  const output = events.filter((event) => event.stream === 'stdout').map((event) => event.chunk).join('');
  assert.match(output, /yes/);
  assert.equal(runner.isRunning('demo'), false);
});

test('日志默认归属 main 服务，文件按服务分目录', async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-run-'));
  const events = [];
  const runner = new Runner({ logRoot, onLog: (payload) => events.push(payload) });

  const { child, logFile } = runner.exec(
    { id: 'demo', dir: workDir, shell: 'cmd', envVars: [] },
    { command: 'echo hi', kind: 'start' },
  );
  await new Promise((resolve) => child.once('exit', resolve));

  const output = events.find((event) => event.stream === 'stdout');
  assert.equal(output.serviceId, 'main');
  assert.equal(output.logFile, logFile);
  assert.ok(logFile.includes(path.join('demo', 'main')));
});

test('显式 serviceId 会进入日志归属和文件路径', async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-run-'));
  const events = [];
  const runner = new Runner({ logRoot, onLog: (payload) => events.push(payload) });

  const { child } = runner.exec(
    { id: 'demo', serviceId: 'db', dir: workDir, shell: 'cmd', envVars: [] },
    { command: 'echo db', kind: 'start' },
  );
  await new Promise((resolve) => child.once('exit', resolve));

  const output = events.find((event) => event.stream === 'stdout');
  assert.equal(output.serviceId, 'db');
  assert.ok(output.logFile.includes(path.join('demo', 'db')));
});

test('状态快照能区分同一项目下的多个服务', async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-log-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-run-'));
  const runner = new Runner({ logRoot });

  const first = runner.exec(
    { id: 'demo', serviceId: 'db', dir: workDir, shell: 'cmd', envVars: [] },
    { command: 'echo 1', kind: 'start' },
  );
  const second = runner.exec(
    { id: 'demo', serviceId: 'api', dir: workDir, shell: 'cmd', envVars: [] },
    { command: 'echo 2', kind: 'start' },
  );

  const status = runner.status('demo');
  assert.equal(status.running, true);
  assert.deepEqual(status.services.sort(), ['api', 'db']);

  await Promise.all([
    new Promise((resolve) => first.child.once('exit', resolve)),
    new Promise((resolve) => second.child.once('exit', resolve)),
  ]);
  assert.equal(runner.isRunning('demo'), false);
});
