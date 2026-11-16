'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { Environment } = require('../electron/environment');

const ROOT = path.join(os.tmpdir(), 'devdock-orchestration');

function makeProfile(overrides = {}) {
  return {
    id: 'p1',
    name: 'full-stack',
    dir: ROOT,
    shell: 'cmd',
    setupCommand: '',
    startCommand: '',
    stopCommand: '',
    envVars: [],
    syncDotEnv: false,
    autoSetup: false,
    services: [],
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

function createHarness({ profile, exitCodes = {}, probeResult = () => ({ ready: true, elapsedMs: 10, attempts: 1 }) }) {
  const store = createStore([profile]);
  const events = [];
  const calls = [];
  const runner = {
    stops: [],
    async stop(id) {
      this.stops.push(id);
      return 1;
    },
    exec(target, { command, kind }) {
      calls.push({ kind, command, cwd: target.dir, envVars: target.envVars });
      events.push(['exec', command]);
      const code = exitCodes[kind] ?? 0;
      return {
        child: {
          once(event, callback) {
            if (event === 'exit') setImmediate(() => callback(code));
          },
        },
        pid: 1000 + calls.length,
      };
    },
    stopAllSync() {},
  };

  const env = new Environment({
    store,
    runner,
    onEvent: (payload) => events.push(['event', payload.type]),
    onLog: () => {},
    waitForPort: async (port) => {
      events.push(['probe', port]);
      return probeResult(port);
    },
  });

  return { env, store, runner, calls, events };
}

const FULL_STACK = makeProfile({
  services: [
    {
      id: 'web',
      name: 'Web',
      role: 'frontend',
      cwd: 'web',
      startCommand: 'npm run dev',
      setupCommand: 'npm install',
      dependsOn: ['api'],
    },
    {
      id: 'api',
      name: 'API',
      role: 'backend',
      cwd: 'server',
      startCommand: 'npm run start:dev',
      setupCommand: 'npm install',
      dependsOn: ['db'],
    },
    {
      id: 'db',
      name: 'PostgreSQL',
      role: 'database',
      cwd: '.',
      startCommand: 'docker compose up -d db',
      port: 5432,
    },
  ],
});

test('多服务按数据库 → 后端 → 前端顺序启动', async () => {
  const { env, calls } = createHarness({ profile: FULL_STACK });
  await env.start('p1');

  assert.deepEqual(
    calls.filter((call) => call.kind === 'start').map((call) => call.command),
    ['docker compose up -d db', 'npm run start:dev', 'npm run dev'],
  );
});

test('数据库启动后先探测端口，再启动后端', async () => {
  const { env, events } = createHarness({ profile: FULL_STACK });
  await env.start('p1');

  const relevant = events.filter((event) => event[0] === 'exec' || event[0] === 'probe');
  assert.deepEqual(relevant, [
    ['exec', 'docker compose up -d db'],
    ['probe', 5432],
    ['exec', 'npm run start:dev'],
    ['exec', 'npm run dev'],
  ]);
});

test('数据库端口未就绪时中止启动', async () => {
  const { env, calls } = createHarness({
    profile: FULL_STACK,
    probeResult: () => ({ ready: false, elapsedMs: 60000, attempts: 20 }),
  });

  await assert.rejects(() => env.start('p1'), /PostgreSQL.*未就绪|未就绪.*5432/);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'start').map((call) => call.command),
    ['docker compose up -d db'],
  );
});

test('服务依赖成环时拒绝启动', async () => {
  const profile = makeProfile({
    services: [
      { id: 'a', startCommand: 'run-a', dependsOn: ['b'] },
      { id: 'b', startCommand: 'run-b', dependsOn: ['a'] },
    ],
  });
  const { env, calls } = createHarness({ profile });

  await assert.rejects(() => env.start('p1'), /依赖.*环/);
  assert.equal(calls.length, 0);
});

test('服务命令在各自的 cwd 下执行', async () => {
  const { env, calls } = createHarness({ profile: FULL_STACK });
  await env.start('p1');

  const api = calls.find((call) => call.command === 'npm run start:dev');
  const web = calls.find((call) => call.command === 'npm run dev');
  assert.equal(api.cwd, path.resolve(ROOT, 'server'));
  assert.equal(web.cwd, path.resolve(ROOT, 'web'));
});

test('服务级环境变量与项目级合并', async () => {
  const profile = makeProfile({
    envVars: [{ key: 'NODE_ENV', value: 'development' }],
    services: [
      { id: 'api', startCommand: 'run-api', envVars: [{ key: 'PORT', value: '4000' }] },
    ],
  });
  const { env, calls } = createHarness({ profile });
  await env.start('p1');

  assert.deepEqual(calls[0].envVars, [
    { key: 'NODE_ENV', value: 'development' },
    { key: 'PORT', value: '4000' },
  ]);
});

test('开启 autoSetup 时按依赖顺序安装各服务依赖', async () => {
  const profile = { ...FULL_STACK, autoSetup: true };
  const { env, calls, store } = createHarness({ profile });
  await env.start('p1');

  assert.deepEqual(
    calls.filter((call) => call.kind === 'setup').map((call) => call.command),
    ['npm install', 'npm install'],
  );
  assert.equal(store.isSetup('p1'), true);
});

test('旧档案（只有顶层 startCommand）仍然单服务启动', async () => {
  const profile = makeProfile({ startCommand: 'npm run dev', services: [] });
  const { env, calls } = createHarness({ profile });
  await env.start('p1');

  assert.deepEqual(
    calls.map((call) => [call.kind, call.command]),
    [['start', 'npm run dev']],
  );
});

test('没有启动命令的服务可以被跳过但仍等待端口', async () => {
  const profile = makeProfile({
    services: [
      { id: 'db', name: 'DB', role: 'database', startCommand: '', port: 5432 },
      { id: 'api', role: 'backend', startCommand: 'run-api', dependsOn: ['db'] },
    ],
  });
  const { env, events, calls } = createHarness({ profile });
  await env.start('p1');

  assert.deepEqual(
    calls.map((call) => call.command),
    ['run-api'],
  );
  assert.ok(events.some((event) => event[0] === 'probe' && event[1] === 5432));
});
