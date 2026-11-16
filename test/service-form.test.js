'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRows, collectServices, validateRows } = require('../renderer/service-form');

const PROFILE = {
  name: 'shop',
  dir: 'D:\\code\\shop',
  startCommand: 'npm run dev',
  setupCommand: 'npm install',
  services: [
    {
      id: 'db',
      name: 'PostgreSQL',
      role: 'database',
      cwd: '.',
      setupCommand: '',
      startCommand: 'docker compose up -d db',
      port: 5432,
      envVars: [],
      dependsOn: [],
    },
    {
      id: 'api',
      name: 'API',
      role: 'backend',
      cwd: 'server',
      setupCommand: 'npm install',
      startCommand: 'npm run start:dev',
      port: 4000,
      envVars: [],
      dependsOn: ['db'],
    },
  ],
};

test('旧档案生成单个 main 行', () => {
  const rows = buildRows({ name: 'legacy', startCommand: 'npm run dev', setupCommand: 'npm install' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'main');
  assert.equal(rows[0].startCommand, 'npm run dev');
  assert.equal(rows[0].role, 'app');
});

test('多服务档案按原顺序生成行', () => {
  const rows = buildRows(PROFILE);
  assert.deepEqual(rows.map((row) => row.id), ['db', 'api']);
  assert.deepEqual(rows[1].dependsOn, ['db']);
});

test('空行被过滤，不产生服务', () => {
  const services = collectServices([
    { id: 'a', name: 'A', startCommand: 'run-a' },
    { id: '', name: '', cwd: '.', startCommand: '', setupCommand: '' },
  ]);
  assert.equal(services.length, 1);
  assert.equal(services[0].startCommand, 'run-a');
});

test('端口转成数字，非法端口为 null', () => {
  const services = collectServices([
    { id: 'a', name: 'A', startCommand: 'run', port: '5432' },
    { id: 'b', name: 'B', startCommand: 'run', port: 'abc' },
  ]);
  assert.equal(services[0].port, 5432);
  assert.equal(services[1].port, null);
});

test('依赖引用不存在的服务时剔除', () => {
  const services = collectServices([
    { id: 'api', name: 'API', startCommand: 'run', dependsOn: ['db', 'ghost'] },
  ]);
  assert.deepEqual(services[0].dependsOn, []);
});

test('保存行时保留角色与目录', () => {
  const services = collectServices([
    { id: 'web', name: 'Web', role: 'frontend', cwd: 'web', startCommand: 'npm run dev' },
  ]);
  assert.equal(services[0].role, 'frontend');
  assert.equal(services[0].cwd, 'web');
});

test('没有任何服务时报错', () => {
  const errors = validateRows([]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /至少/);
});

test('服务没有命令时报错并指出服务名', () => {
  const errors = validateRows([{ id: 'api', name: 'API', startCommand: '', setupCommand: '' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /API/);
});

test('依赖成环时报错', () => {
  const errors = validateRows([
    { id: 'a', name: 'A', startCommand: 'run-a', dependsOn: ['b'] },
    { id: 'b', name: 'B', startCommand: 'run-b', dependsOn: ['a'] },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /环/);
});

test('合法配置没有错误', () => {
  assert.deepEqual(validateRows(PROFILE.services), []);
});
