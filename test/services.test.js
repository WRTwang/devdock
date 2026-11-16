'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveServices, normalizeService } = require('../electron/services');

test('既有 startCommand 的旧档案迁移成单个 app 服务', () => {
  const services = resolveServices({
    name: 'legacy-app',
    startCommand: 'npm run dev',
    setupCommand: 'npm install',
    envVars: [{ key: 'NODE_ENV', value: 'development' }],
  });

  assert.equal(services.length, 1);
  assert.equal(services[0].id, 'main');
  assert.equal(services[0].name, 'legacy-app');
  assert.equal(services[0].role, 'app');
  assert.equal(services[0].cwd, '.');
  assert.equal(services[0].startCommand, 'npm run dev');
  assert.equal(services[0].setupCommand, 'npm install');
  assert.deepEqual(services[0].envVars, [{ key: 'NODE_ENV', value: 'development' }]);
  assert.deepEqual(services[0].dependsOn, []);
});

test('没有任何命令的档案得到空服务列表', () => {
  assert.deepEqual(resolveServices({ name: 'empty' }), []);
});

test('新档案的 services 原样保留并归一化字段', () => {
  const services = resolveServices({
    name: 'full-stack',
    startCommand: 'npm run dev',
    services: [
      { id: 'db', name: 'PostgreSQL', role: 'database', port: 5432 },
      {
        id: 'api',
        name: 'API',
        role: 'backend',
        cwd: 'server',
        startCommand: 'npm run start:dev',
        port: '4000',
        dependsOn: ['db'],
      },
      { id: 'web', name: 'Web', role: 'frontend', cwd: 'web', startCommand: 'npm run dev', dependsOn: ['api'] },
    ],
  });

  assert.equal(services.length, 3);
  assert.equal(services[0].role, 'database');
  assert.equal(services[1].port, 4000);
  assert.deepEqual(services[1].dependsOn, ['db']);
  assert.equal(services[2].cwd, 'web');
  // 有 services 时不再用顶层 startCommand 造迁移服务
  assert.equal(services.some((service) => service.id === 'main'), false);
});

test('缺失 id 的服务按顺序生成稳定编号', () => {
  const services = resolveServices({
    name: 'x',
    services: [{ name: 'A', startCommand: 'a' }, { name: 'B', startCommand: 'b' }, { name: 'C', startCommand: 'c' }],
  });
  assert.deepEqual(services.map((service) => service.id), ['main', 'svc-2', 'svc-3']);
});

test('非法 role 回落为 app，非法 port 回落到 null', () => {
  const service = normalizeService({ id: 'x', role: 'queen', port: 70000 }, 0);
  assert.equal(service.role, 'app');
  assert.equal(service.port, null);

  const negative = normalizeService({ id: 'y', port: -1 }, 1);
  assert.equal(negative.port, null);

  const zero = normalizeService({ id: 'z', port: 0 }, 2);
  assert.equal(zero.port, null);
});

test('服务字段缺省值可预测', () => {
  const service = normalizeService({}, 0);
  assert.equal(service.id, 'main');
  assert.equal(service.name, 'main');
  assert.equal(service.role, 'app');
  assert.equal(service.cwd, '.');
  assert.equal(service.setupCommand, '');
  assert.equal(service.startCommand, '');
  assert.equal(service.port, null);
  assert.deepEqual(service.envVars, []);
  assert.deepEqual(service.dependsOn, []);
});

test('dependsOn 过滤空值并去重', () => {
  const service = normalizeService({ id: 'api', dependsOn: ['db', '', null, 'db', 'cache'] }, 0);
  assert.deepEqual(service.dependsOn, ['db', 'cache']);
});

test('services 非数组时视为未提供', () => {
  const services = resolveServices({ name: 'x', startCommand: 'run', services: 'nope' });
  assert.equal(services.length, 1);
  assert.equal(services[0].id, 'main');
});
