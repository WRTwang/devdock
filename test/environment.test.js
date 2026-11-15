'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Environment } = require('../electron/environment');

function makeProfile(overrides = {}) {
  return {
    id: 'p1',
    name: 'demo',
    dir: os.tmpdir(),
    shell: 'cmd',
    setupCommand: 'npm install',
    startCommand: 'npm run dev',
    stopCommand: '',
    envVars: [],
    syncDotEnv: false,
    autoSetup: true,
    ...overrides,
  };
}

function createStore(profiles) {
  const state = { profiles: [...profiles], activeId: null, setupAt: {} };
  return {
    state,
    getState: () => state,
    list: () => state.profiles,
    find: (id) => state.profiles.find((profile) => profile.id === id) || null,
    setActive: (id) => {
      state.activeId = id;
    },
    markSetup: (id) => {
      state.setupAt[id] = Date.now();
    },
    isSetup: (id) => Boolean(state.setupAt[id]),
    remove: (id) => {
      state.profiles = state.profiles.filter((profile) => profile.id !== id);
      if (state.activeId === id) state.activeId = null;
    },
  };
}

function createRunner(exitCodes = {}) {
  const calls = [];
  const stopped = [];
  return {
    calls,
    stopped,
    stopAllSyncCalled: false,
    async stop(id) {
      stopped.push(id);
      calls.push(['stop', id]);
      return 1;
    },
    exec(profile, { command, kind }) {
      calls.push(['exec', kind, command]);
      const code = exitCodes[kind] ?? 0;
      const child = {
        once(event, callback) {
          if (event === 'exit') setImmediate(() => callback(code));
        },
      };
      return { child, pid: 1234 };
    },
    stopAllSync() {
      this.stopAllSyncCalled = true;
    },
  };
}

function setup(profiles, exitCodes) {
  const store = createStore(profiles);
  const runner = createRunner(exitCodes);
  const events = [];
  const logs = [];
  const env = new Environment({
    store,
    runner,
    onEvent: (payload) => events.push(payload),
    onLog: (payload) => logs.push(payload),
  });
  return { env, store, runner, events, logs };
}

test('首次激活不会停止任何进程', async () => {
  const { env, store, runner } = setup([makeProfile()]);
  const result = await env.activate('p1');
  assert.equal(result.switched, true);
  assert.equal(store.getState().activeId, 'p1');
  assert.deepEqual(runner.stopped, []);
});

test('切换环境会停止旧项目并广播切换事件', async () => {
  const { env, store, runner, events, logs } = setup([
    makeProfile({ id: 'a', name: 'A' }),
    makeProfile({ id: 'b', name: 'B' }),
  ]);

  await env.activate('a');
  await env.activate('b');

  assert.deepEqual(runner.stopped, ['a']);
  assert.equal(store.getState().activeId, 'b');
  assert.ok(events.some((event) => event.type === 'active' && event.activeId === 'b'));
  assert.ok(logs.some((entry) => entry.chunk.includes('A → B')));
});

test('重复激活同一个项目不做任何清理', async () => {
  const { env, runner } = setup([makeProfile({ id: 'a' })]);
  await env.activate('a');
  const result = await env.activate('a');
  assert.equal(result.switched, false);
  assert.deepEqual(runner.stopped, []);
});

test('激活不存在的项目会抛错', async () => {
  const { env } = setup([]);
  await assert.rejects(() => env.activate('ghost'), /项目不存在/);
});

test('启动前若未搭环境且开启 autoSetup，会先执行安装', async () => {
  const { env, store, runner, events } = setup([makeProfile({ id: 'a' })]);
  await env.start('a');

  const execCalls = runner.calls.filter((call) => call[0] === 'exec');
  assert.deepEqual(execCalls, [
    ['exec', 'setup', 'npm install'],
    ['exec', 'start', 'npm run dev'],
  ]);
  assert.equal(store.isSetup('a'), true);
  assert.ok(events.some((event) => event.type === 'setup-done'));
});

test('已经搭过环境则直接启动', async () => {
  const { env, store, runner } = setup([makeProfile({ id: 'a' })]);
  store.markSetup('a');
  await env.start('a');

  const execCalls = runner.calls.filter((call) => call[0] === 'exec');
  assert.deepEqual(execCalls, [['exec', 'start', 'npm run dev']]);
});

test('安装失败时中止启动', async () => {
  const { env, runner } = setup([makeProfile({ id: 'a' })], { setup: 1 });
  await assert.rejects(() => env.start('a'), /环境搭建失败/);
  const execCalls = runner.calls.filter((call) => call[0] === 'exec');
  assert.equal(execCalls.length, 1);
});

test('手动搭环境失败会广播 error 事件', async () => {
  const { env, events } = setup([makeProfile({ id: 'a' })], { setup: 2 });
  await env.setup('a');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(events.some((event) => event.type === 'error' && /退出码 2/.test(event.message)));
});

test('启动会先把该项目设为活跃环境', async () => {
  const { env, store, runner } = setup([
    makeProfile({ id: 'a', name: 'A' }),
    makeProfile({ id: 'b', name: 'B' }),
  ]);
  await env.activate('a');
  await env.start('b');
  assert.equal(store.getState().activeId, 'b');
  assert.deepEqual(runner.stopped, ['a']);
});

test('停止项目会还原 .env 并广播', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdock-envstop-'));
  fs.writeFileSync(path.join(dir, '.env'), 'ORIGINAL=1\n', 'utf8');
  const dotenv = require('../electron/dotenv');
  dotenv.apply(dir, [{ key: 'ORIGINAL', value: '2' }]);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /ORIGINAL=2/);

  const { env, events } = setup([makeProfile({ id: 'a', dir, syncDotEnv: true })]);
  await env.stop('a');

  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ORIGINAL=1\n');
  assert.ok(events.some((event) => event.type === 'stopped'));
});

test('删除项目会先停进程再移除档案', async () => {
  const { env, store, runner } = setup([makeProfile({ id: 'a' })]);
  await env.activate('a');
  await env.remove('a');

  assert.deepEqual(runner.stopped, ['a']);
  assert.equal(store.getState().activeId, null);
  assert.equal(store.list().length, 0);
});

test('shutdown 同步清理全部进程', () => {
  const { env, runner } = setup([makeProfile({ id: 'a' })]);
  env.shutdown();
  assert.equal(runner.stopAllSyncCalled, true);
});
